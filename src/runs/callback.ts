/**
 * Result delivery by callback (SPEC §7): one logical result,
 * at-least-once — 5 attempts, pauses 2 → 4 → 8 → 16 s, the whole schedule ≈ 80 s.
 * Duplicates are possible; the harness dedupes by run_id.
 *
 * A run has exactly one delivery job, started by finish(). Shutdown does not start
 * a second one but switches this one with the `stopping` signal: the pause is cut short,
 * leaving one last attempt with a 2 s timeout (SPEC §11.1).
 *
 * 2xx = ack: the harness answers 2xx only after a durable write (SPEC §3.1),
 * so the session lock is released right here.
 */
import { ENGINE_SECRET_HEADER, type Config } from '../config.js'
import type { RunResult } from '../contracts.js'
import type { EgressClient } from '../egress/client.js'
import { sendAlert } from '../alerts.js'
import { log, redactSecrets, safeUrl } from '../log.js'
import type { RunRecord, RunRegistry } from './registry.js'

const BACKOFF_MS = [2000, 4000, 8000, 16000]
const MAX_ATTEMPTS = 5
/** Attempt timeout after the stop signal (SPEC §11.1). */
const SHUTDOWN_ATTEMPT_TIMEOUT_MS = 2000
/** Read cap for the callback response — 64 KB (SPEC §5.3). */
const CALLBACK_RESPONSE_MAX_BYTES = 65_536
/** How many characters of a non-2xx response body go into last_error (GET /runs/{id}, error webhook). */
const CALLBACK_ERROR_BODY_CHARS = 300

/** Header carrying the engine secret from env CALLBACK_SECRET (SPEC §7). */
export const CALLBACK_SECRET_HEADER = ENGINE_SECRET_HEADER

/**
 * Callback headers: callback.headers from the request + the engine secret from env.
 * The env secret wins — a request header with the same name is dropped, otherwise
 * the client could replace the engine's signature with its own.
 */
export function buildCallbackHeaders(
  requestHeaders: Record<string, string> | null | undefined,
  secret: string | undefined,
): Record<string, string> | undefined {
  if (!secret) return requestHeaders ?? undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(requestHeaders ?? {})) {
    if (name.trim().toLowerCase() !== CALLBACK_SECRET_HEADER.toLowerCase()) out[name] = value
  }
  out[CALLBACK_SECRET_HEADER] = secret
  return out
}

/**
 * Callback body (SPEC §7): the whole result in a single `payload` field.
 * A flat body does not fit receivers such as low-code endpoints: they reject any field
 * outside their list and do not store a top-level array (`messages`, `tool_calls`) in a
 * json field. With one json field the endpoint needs exactly one allowed field, and
 * new result fields do not break it. Callback only — GET / wait / cancel / SSE
 * return the result as is.
 */
export function buildCallbackBody(result: RunResult): { payload: RunResult } {
  return { payload: result }
}

export interface DeliveryDeps {
  config: Config
  egress: EgressClient
  registry: RunRegistry
  /** The engine is stopping: no more retries, one last attempt ≤ 2 s. */
  stopping?: AbortSignal
}

export async function deliverCallback(run: RunRecord, result: RunResult, deps: DeliveryDeps): Promise<void> {
  const delivery = run.delivery
  // the final state is already recorded — a second job must not overwrite it
  if (delivery.status !== 'pending') return
  if (!delivery.url) {
    delivery.status = 'none'
    return
  }

  const url = delivery.url
  const headers = buildCallbackHeaders(delivery.headers, deps.config.callbackSecret)
  const body = JSON.stringify(buildCallbackBody(result))

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    delivery.attempts = attempt
    const started = Date.now()
    const timeoutMs = deps.stopping?.aborted
      ? SHUTDOWN_ATTEMPT_TIMEOUT_MS
      : deps.config.callbackAttemptTimeoutMs
    try {
      const res = await deps.egress.request({
        url,
        method: 'POST',
        headers,
        body,
        timeoutMs,
        maxBytes: CALLBACK_RESPONSE_MAX_BYTES,
        purpose: 'callback',
      })
      if (res.status >= 200 && res.status < 300) {
        delivery.status = 'delivered'
        delivery.lastError = null
        delivery.nextAttemptAt = null
        // phase 3: the delivery job is no longer needed — drop the callback headers
        delivery.url = null
        delivery.headers = null
        log.info('callback_sent', {
          run_id: run.runId,
          session_id: run.sessionId,
          attempts: attempt,
          http_status: res.status,
          duration_ms: Date.now() - started,
          url: safeUrl(url),
        })
        deps.registry.ack(run, 'callback') // 2xx = durable write in the harness (SPEC §3.1)
        return
      }
      // the refusal reason is in the receiver's response body; without it "HTTP 400" cannot be diagnosed
      const snippet = redactSecrets(res.text).replace(/\s+/g, ' ').trim().slice(0, CALLBACK_ERROR_BODY_CHARS)
      delivery.lastError = snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`
    } catch (err) {
      delivery.lastError = err instanceof Error ? err.message : String(err)
    }

    // engine stopping: this attempt was the last one (SPEC §11.1)
    const last = attempt >= MAX_ATTEMPTS || deps.stopping?.aborted === true
    const pause = last ? null : (BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!)
    log.warn('callback_attempt_failed', {
      run_id: run.runId,
      attempt,
      max_attempts: MAX_ATTEMPTS,
      duration_ms: Date.now() - started,
      error: delivery.lastError,
      next_in_ms: pause,
      shutdown: deps.stopping?.aborted || undefined,
    })
    if (pause == null) break
    delivery.nextAttemptAt = new Date(Date.now() + pause).toISOString()
    await sleep(pause, deps.stopping)
  }

  delivery.status = 'failed'
  delivery.nextAttemptAt = null
  delivery.url = null
  delivery.headers = null
  log.error('callback_failed', {
    run_id: run.runId,
    session_id: run.sessionId,
    meta: run.meta,
    status: result.status,
    error: delivery.lastError,
    attempts: delivery.attempts,
  })
  sendAlert('callback_failed', {
    run_id: run.runId,
    session_id: run.sessionId,
    meta: run.meta,
    status: result.status,
    finish_reason: result.finish_reason,
    callback: { url: safeUrl(url), attempts: delivery.attempts, last_error: delivery.lastError },
  })
}

/** A pause cut short by the stop signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    if (typeof t.unref === 'function') t.unref()
    signal?.addEventListener('abort', done, { once: true })
  })
}
