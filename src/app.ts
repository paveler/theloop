/**
 * HTTP layer (SPEC §4): routes, auth, CORS, body limit, graceful shutdown.
 *
 * Server endpoints use Bearer ENGINE_TOKEN; browser ones (stream / cancel) use the
 * run token from the POST /runs response; tool-result uses the per-call token from result_url.
 */
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { Config } from './config.js'
import {
  CONTRACT_VERSION,
  ToolResultBodySchema,
  publicError,
  type RunResult,
} from './contracts.js'
import { EgressClient } from './egress/client.js'
import { EngineError } from './errors.js'
import { newRunId, hashBody, timingSafeEqualStr } from './ids.js'
import { configureAlerts, sendAlert } from './alerts.js'
import { initLogger, log, logBuffer, logContentEnabled, logger, safeUrl } from './log.js'
import { formatLogText, LOG_LEVELS, type LogLevel, type LogQuery } from './log-buffer.js'
import { buildModel, type ModelFactory } from './providers/factory.js'
import { pinnedProviderHosts } from './providers/allowlist.js'
import { ProviderThrottle } from './providers/throttle.js'
import { RunRegistry, isTerminal, type RunRecord } from './runs/registry.js'
import { startRun } from './runs/runner.js'
import { validateRunRequest } from './runs/validate.js'

const CANCEL_WAIT_MS = 5000
const LOGS_DEFAULT_LIMIT = 1000
const LOGS_MAX_LIMIT = 10_000

export interface EngineDeps {
  config: Config
  egress: EgressClient
  registry: RunRegistry
  modelFactory: ModelFactory
  /** Fires at shutdown step 3: callback delivery gets one last attempt. */
  stopping: AbortSignal
  /** Queue and AIMD concurrency ceiling per provider key (SPEC §11.6). */
  throttle: ProviderThrottle
}

export interface Engine {
  app: Hono
  deps: EngineDeps
  shuttingDown: () => boolean
  shutdown: () => Promise<void>
  version: string
}

export function createEngine(
  config: Config,
  overrides: Partial<Pick<EngineDeps, 'modelFactory' | 'egress' | 'registry'>> = {},
  version = '0.1.0',
): Engine {
  initLogger(config)
  const egress = overrides.egress ?? new EgressClient(config)
  for (const host of pinnedProviderHosts()) egress.allowHost(host)
  const registry = overrides.registry ?? new RunRegistry(config)
  registry.startSweeper()
  configureAlerts(
    config.errorWebhookUrl
      ? { url: config.errorWebhookUrl, secret: config.callbackSecret, egress, version }
      : null,
  )

  const stopping = new AbortController()
  const deps: EngineDeps = {
    config,
    egress,
    registry,
    modelFactory: overrides.modelFactory ?? buildModel,
    stopping: stopping.signal,
    throttle: new ProviderThrottle(config.providerThrottle),
  }

  let shuttingDown = false
  const startedAt = Date.now()
  const app = new Hono()

  if (config.allowedOrigins.length > 0) {
    app.use(
      '/runs/*',
      cors({
        origin: config.allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
        maxAge: 600,
      }),
    )
  }

  // access log: the query token is not written (SPEC §12.2); stdout only, not the journal
  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    logger().debug(
      {
        method: c.req.method,
        url: safeUrl(new URL(c.req.url).pathname + new URL(c.req.url).search),
        status: c.res.status,
        duration_ms: Date.now() - started,
      },
      'http_request',
    )
  })

  app.onError((err, c) => {
    if (err instanceof EngineError) {
      return c.json(err.toBody(), err.status as never)
    }
    log.error('unhandled_error', {
      method: c.req.method,
      path: c.req.path,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    sendAlert('unhandled_error', { path: c.req.path, error: { message: String(err).slice(0, 512) } })
    return c.json(
      { error: { code: 'internal_error', message: 'internal error', retriable: false } },
      500,
    )
  })

  /* --------------------------------------------------------------- health */

  app.get('/health', (c) =>
    c.json({
      ok: true,
      version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      active_runs: registry.activeCount,
      retained_runs: registry.retainedCount,
      shutting_down: shuttingDown,
      // provider queue: AIMD ceiling, busy slots, waiters (SPEC §4.7, §11.6)
      provider_throttle: deps.throttle.snapshot(),
    }),
  )

  /* ---------------------------------------------------------- POST /runs */

  app.post('/runs', async (c) => {
    let raw: unknown
    try {
      if (shuttingDown) throw new EngineError('shutting_down', 'engine is shutting down')
      requireEngineToken(c.req.header('authorization'), config)
      raw = await readJsonBody(c.req.raw, config.maxRequestBytes)
      return await acceptRun(c, raw)
    } catch (err) {
      // the caller gets the refusal, but the journal needs it too — otherwise "the harness
      // sends, but there is no run" cannot be diagnosed (SPEC §12.4)
      if (err instanceof EngineError) logRunRejected(err, raw)
      throw err
    }
  })

  async function acceptRun(c: Context, raw: unknown): Promise<Response> {
    const validated = validateRunRequest(raw, deps)
    const { request, resolved, limits, sessionId, outputChecks } = validated

    // idempotency is checked BEFORE the session lock (SPEC §11.2)
    const requestHash = hashBody(raw)
    if (request.idempotency_key) {
      const existing = registry.findByIdempotencyKey(request.idempotency_key)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new EngineError('idempotency_mismatch', 'same key, different request body', {
            existing_run_id: existing.runId,
          })
        }
        log.info('run_replayed', {
          run_id: existing.runId,
          session_id: existing.sessionId,
          idempotency_key: request.idempotency_key,
          status: existing.status,
        })
        return c.json(runAcceptedBody(existing, config), 200)
      }
    }

    // the session lock is held until ack (SPEC §3.1)
    if (sessionId) {
      const holder = registry.sessionLockHolder(sessionId)
      if (holder) {
        if (!isTerminal(holder.status)) {
          throw new EngineError('session_busy', 'a run is already in progress for this session', {
            active_run_id: holder.runId,
          })
        }
        throw new EngineError('result_pending', 'the previous run result has not been acked', {
          pending_run_id: holder.runId,
        })
      }
    }

    registry.ensureCapacity()

    const record = registry.create({
      runId: newRunId(),
      request,
      requestHash,
      sessionId,
      liveUsage: () => registry.emptyUsage(),
    })

    const running = startRun(record, { request, resolved, limits, outputChecks }, deps).catch((err) => {
      log.error('run_crashed', {
        run_id: record.runId,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      sendAlert('run_crashed', {
        run_id: record.runId,
        session_id: record.sessionId,
        meta: record.meta,
        error: { message: String(err).slice(0, 512) },
      })
    })

    if (request.wait) {
      await running
      const result = record.result
      if (!result) throw new EngineError('internal_error', 'run finished without a result')
      // wait without session_id — no lock, ack is automatic (SPEC §3.1)
      if (!sessionId) registry.ack(record, 'wait')
      return c.json(result as unknown as Record<string, unknown>, 200)
    }

    return c.json(runAcceptedBody(record, config), 202)
  }

  /* --------------------------------------------------------- GET /runs/id */

  app.get('/runs/:id', (c) => {
    requireEngineToken(c.req.header('authorization'), config)
    const run = mustGetRun(registry, c.req.param('id'))

    if (!isTerminal(run.status) || !run.result) {
      return c.json({
        run_id: run.runId,
        status: run.status === 'cancelling' ? 'running' : run.status,
        meta: run.meta,
        timing: { started_at: run.startedAtIso },
        steps: run.steps,
        usage: run.liveUsage(),
      })
    }

    return c.json({
      ...(run.result as unknown as Record<string, unknown>),
      acked: run.acked,
      callback: {
        status: run.delivery.status,
        attempts: run.delivery.attempts,
        last_error: run.delivery.lastError,
        next_attempt_at: run.delivery.nextAttemptAt,
      },
    })
  })

  /* -------------------------------------------------- GET /runs/id/stream */

  app.get('/runs/:id/stream', (c) => {
    const run = mustGetRun(registry, c.req.param('id'))
    authorizeRunAccess(c.req.header('authorization'), c.req.query('token'), run, config)

    const lastEventHeader = c.req.header('last-event-id') ?? c.req.query('last_event_id')
    const lastEventId = lastEventHeader != null && lastEventHeader !== '' ? Number(lastEventHeader) : null
    const stream = run.sse.subscribe(Number.isFinite(lastEventId) ? (lastEventId as number) : null)
    log.debug('sse_subscribe', { run_id: run.runId, status: run.status, last_event_id: lastEventHeader || undefined })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  /* -------------------------------------------------- POST /runs/id/cancel */

  app.post('/runs/:id/cancel', async (c) => {
    const run = mustGetRun(registry, c.req.param('id'))
    const auth = authorizeRunAccess(c.req.header('authorization'), c.req.query('token'), run, config)

    if (isTerminal(run.status) && run.result) {
      return withNoStore(c.json(resultFor(run.result, auth), 200))
    }

    if (run.status === 'running') {
      run.status = 'cancelling'
      run.abortReason = 'user'
      run.abort.abort(new Error('cancelled_by_user'))
      log.info('cancel', { run_id: run.runId, session_id: run.sessionId, by: auth, step: run.steps })
    }

    const raced = await Promise.race([
      run.terminal.then(() => 'terminal' as const),
      sleep(CANCEL_WAIT_MS).then(() => 'timeout' as const),
    ])

    if (raced === 'terminal' && run.result) {
      return withNoStore(c.json(resultFor(run.result, auth), 200))
    }
    return withNoStore(c.json({ run_id: run.runId, status: 'cancelling' }, 202))
  })

  /* --------------------------------------------- POST /runs/id/tool-result */

  app.post('/runs/:id/tool-result', async (c) => {
    const id = c.req.param('id')
    const run = id ? registry.get(id) : undefined
    // run deleted or call_id unknown — both are 404 call_not_found (SPEC §4.5)
    if (!run) throw new EngineError('call_not_found', 'run deleted or does not exist')
    const token = c.req.query('token')
    const bearer = c.req.header('authorization')
    const byEngine = bearer != null && matchesEngineToken(bearer, config)
    if (!byEngine) {
      if (!token || !registry.callByToken(run, token)) {
        throw new EngineError('unauthorized', 'requires the per-call token from result_url or Bearer')
      }
    }

    const raw = await readJsonBody(c.req.raw, config.maxRequestBytes)
    const parsed = ToolResultBodySchema.safeParse(raw)
    if (!parsed.success) throw new EngineError('bad_request', 'invalid tool-result body')

    if (!byEngine) {
      const call = registry.callByToken(run, token!)
      if (!call || call.callId !== parsed.data.call_id) {
        throw new EngineError('unauthorized', 'token does not belong to this call_id')
      }
    }

    const outcome = registry.submitToolResult(run, parsed.data)
    return withNoStore(c.json(outcome, 200))
  })

  /* ----------------------------------------------------- POST /runs/id/ack */

  app.post('/runs/:id/ack', (c) => {
    requireEngineToken(c.req.header('authorization'), config)
    const run = mustGetRun(registry, c.req.param('id'))
    if (!isTerminal(run.status)) throw new EngineError('not_finished', 'run has not finished yet')
    registry.ack(run, 'endpoint')
    return c.json({ acked: true }, 200)
  })

  /* ------------------------------------------------------------------ logs */

  // in-memory event journal (SPEC §4.9, §12.4): content only with ENGINE_TOKEN,
  // the same access level as GET /runs/{id} with messages
  app.get('/logs', (c) => {
    requireEngineToken(c.req.header('authorization'), config)
    const { query, format } = parseLogQuery(c.req.query())
    return logsResponse(c, query, format)
  })

  app.get('/runs/:id/logs', (c) => {
    requireEngineToken(c.req.header('authorization'), config)
    const id = c.req.param('id')
    const { query, format } = parseLogQuery(c.req.query())
    query.runId = id
    if (query.since == null && !registry.get(id) && logBuffer().query({ runId: id, limit: 1 }).entries.length === 0) {
      throw new EngineError('run_not_found', 'run not found in the registry or the journal: restarted, evicted, or never existed')
    }
    return logsResponse(c, query, format)
  })

  /* -------------------------------------------------------------- shutdown */

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown', { active_runs: registry.activeCount })

    const inFlight = [...registry.all()].filter((r) => !isTerminal(r.status))
    if (inFlight.length > 0) {
      await Promise.race([
        Promise.all(inFlight.map((r) => r.terminal)),
        sleep(config.shutdownGraceMs),
      ])
    }

    // from here on callback delivery gets one last attempt of ≤ 2 s: no retries,
    // the pause between attempts is cut short. A run has a single delivery task —
    // finish() starts it, a second one is never started (SPEC §11.1)
    stopping.abort()

    // runs that did not make it — abort, as on cancel
    const stragglers = [...registry.all()].filter((r) => !isTerminal(r.status))
    for (const run of stragglers) {
      run.abortReason = 'shutdown'
      run.status = 'cancelling'
      run.abort.abort(new Error('shutdown'))
    }
    if (stragglers.length > 0) {
      await Promise.race([Promise.all(stragglers.map((r) => r.terminal)), sleep(2000)])
    }

    // undelivered callbacks are not held longer than 2 s: delivery is best-effort,
    // the harness fetches the result via GET at its deadline (SPEC §3, §11.1).
    // GigaChat file deletion fits in the same 2 s (SPEC §5.3)
    await Promise.race([
      Promise.all(
        [...registry.all()].flatMap((r) => [
          r.deliveryPromise ?? Promise.resolve(),
          r.releasePromise ?? Promise.resolve(),
        ]),
      ),
      sleep(2000),
    ])
    registry.stopSweeper()
  }

  return { app, deps, shuttingDown: () => shuttingDown, shutdown, version }
}

/* ------------------------------------------------------------- helpers */

function logRunRejected(err: EngineError, raw: unknown): void {
  const body = (raw ?? {}) as {
    llm?: { provider?: unknown; model?: unknown }
    meta?: { session_id?: unknown }
    idempotency_key?: unknown
    messages?: unknown
  }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
  log.warn('run_rejected', {
    session_id: str(body.meta?.session_id),
    http_status: err.status,
    code: err.code,
    message: err.message,
    ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
    idempotency_key: str(body.idempotency_key),
    provider: str(body.llm?.provider),
    model: str(body.llm?.model),
    messages: Array.isArray(body.messages) ? body.messages.length : undefined,
  })
}

function parseLogQuery(q: Record<string, string>): { query: LogQuery; format: 'json' | 'text' } {
  const level = q.level || undefined
  if (level && !(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new EngineError('bad_request', `level: one of ${LOG_LEVELS.join(', ')}`)
  }
  const since = q.since ? Number(q.since) : undefined
  if (since != null && (!Number.isInteger(since) || since < 0)) {
    throw new EngineError('bad_request', 'since: integer ≥ 0 — seq of the last seen entry')
  }
  const limit = q.limit ? Number(q.limit) : LOGS_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) throw new EngineError('bad_request', 'limit: integer ≥ 1')
  const format = q.format || 'json'
  if (format !== 'json' && format !== 'text') throw new EngineError('bad_request', 'format: json or text')

  return {
    query: {
      runId: q.run_id || undefined,
      sessionId: q.session_id || undefined,
      events: q.event ? q.event.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      minLevel: level as LogLevel | undefined,
      since,
      limit: Math.min(limit, LOGS_MAX_LIMIT),
    },
    format,
  }
}

function logsResponse(c: Context, query: LogQuery, format: 'json' | 'text'): Response {
  const buffer = logBuffer()
  const { entries, truncated } = buffer.query(query)
  const stats = buffer.stats()
  // with since and truncation — page on from the last returned entry; otherwise everything
  // matched up to last_seq has been returned, and the tail continues from it
  const nextSince = truncated && query.since != null ? entries.at(-1)!.seq : stats.last_seq

  if (format === 'text') {
    const head = truncated
      ? `# showing ${entries.length}, more matched — narrow the filter or page with since=${nextSince}\n`
      : ''
    // what is common to the whole selection goes into the header instead of every line
    const hide = [
      ...(query.runId ? ['run_id'] : []),
      ...(query.runId || query.sessionId ? ['session_id'] : []),
    ]
    const sessionId =
      query.sessionId ?? (query.runId ? entries.find((e) => e.session_id)?.session_id : undefined)
    const scope = [query.runId && `run_id=${query.runId}`, sessionId && `session_id=${sessionId}`].filter(Boolean)
    const title = scope.length > 0 ? `# ${scope.join(' ')}\n` : ''
    const body = entries.length > 0 ? formatLogText(entries, hide) : '# empty\n'
    return withNoStore(c.text(title + head + body))
  }
  return withNoStore(
    c.json({
      entries,
      truncated,
      next_since: nextSince,
      buffer: { ...stats, content: logContentEnabled() },
    }),
  )
}

function runAcceptedBody(run: RunRecord, config: Config): Record<string, unknown> {
  return {
    run_id: run.runId,
    status: isTerminal(run.status) ? run.status : 'running',
    stream_url: `${config.publicUrl}/runs/${run.runId}/stream?token=${run.token}`,
    cancel_url: `${config.publicUrl}/runs/${run.runId}/cancel?token=${run.token}`,
    retention_ms: config.runRetentionMs,
    contract_version: CONTRACT_VERSION,
  }
}

function mustGetRun(registry: RunRegistry, id: string | undefined): RunRecord {
  const run = id ? registry.get(id) : undefined
  if (!run) throw new EngineError('run_not_found', 'run not found or already deleted')
  return run
}

function matchesEngineToken(header: string | undefined, config: Config): boolean {
  if (!header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match?.[1]) return false
  return config.engineTokens.some((t) => timingSafeEqualStr(t, match[1]!))
}

function requireEngineToken(header: string | undefined, config: Config): void {
  if (!matchesEngineToken(header, config)) {
    throw new EngineError('unauthorized', 'requires Authorization: Bearer <ENGINE_TOKEN>')
  }
}

type RunAuth = 'engine' | 'run-token'

function authorizeRunAccess(
  header: string | undefined,
  token: string | undefined,
  run: RunRecord,
  config: Config,
): RunAuth {
  if (matchesEngineToken(header, config)) return 'engine'
  if (token && timingSafeEqualStr(run.token, token)) return 'run-token'
  throw new EngineError('unauthorized', 'requires a run token or Bearer <ENGINE_TOKEN>')
}

/**
 * With a run token (browser) `messages` are not returned: they hold tool results and
 * reasoning, which SSE hides behind the stream.expose_* flags (SPEC §6.6). Nor is
 * `error.provider_body`: the provider body may quote the prompt. The browser gets exactly
 * what the done event carries; the full §7 body is ENGINE_TOKEN only.
 */
function resultFor(result: RunResult, auth: RunAuth): Record<string, unknown> {
  if (auth === 'engine') return result as unknown as Record<string, unknown>
  const { messages: _messages, error, ...rest } = result
  return { ...rest, error: error ? publicError(error) : null }
}

function withNoStore(res: Response): Response {
  res.headers.set('Cache-Control', 'no-store')
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}

/**
 * The body is read as a stream capped at MAX_REQUEST_BYTES: a chunked request without
 * Content-Length must not land in memory whole before the check (SPEC §4).
 */
async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = req.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    throw new EngineError('payload_too_large', `body exceeds ${maxBytes} bytes`)
  }

  const body = req.body
  let text: string
  if (!body) {
    text = ''
  } else {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new EngineError('payload_too_large', `body exceeds ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock?.()
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  }

  if (text.trim().length === 0) throw new EngineError('bad_request', 'empty request body')
  try {
    return JSON.parse(text)
  } catch {
    throw new EngineError('bad_request', 'body is not valid JSON')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

export type { RunResult }
