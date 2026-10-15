/**
 * Calling a tool endpoint (SPEC §6.1, §6.2).
 *
 * A tool is a POST to a URL from the request. Responses: ok | error | accepted | deferred;
 * any other 2xx body counts as the result in full (the harness endpoint does not have to
 * wrap it). A tool-error does not fail the run — it goes to the model.
 */
import type { ToolCallStatus, ToolDef } from '../contracts.js'
import { CONTRACT_VERSION, ToolEnvelopeSchema } from '../contracts.js'
import { BodyTooLargeError, type EgressClient } from '../egress/client.js'
import { EngineError } from '../errors.js'
import { log, safeUrl } from '../log.js'

export type ToolOutcome =
  | { kind: 'ok'; result: unknown; truncated: boolean }
  | { kind: 'error'; error: string; status: Extract<ToolCallStatus, 'error' | 'timeout' | 'http_error' | 'protocol_error'> }
  | { kind: 'deferred'; operationId: string }

export interface AsyncToolResult {
  result?: unknown
  error?: string
  is_error: boolean
}

export interface ToolCallContext {
  runId: string
  callId: string
  originRequestId: string | null
  meta: Record<string, unknown>
  /** URL for the tool's async response (SPEC §6.2). */
  resultUrl: string
  toolResultMaxBytes: number
  /** Read cap for the tool response body, TOOL_RESPONSE_MAX_BYTES (SPEC §6.2). */
  toolResponseMaxBytes: number
  signal: AbortSignal
  /** Waits for POST /runs/{id}/tool-result after status: accepted. */
  waitForAsyncResult: (callId: string, timeoutMs: number, signal: AbortSignal) => Promise<AsyncToolResult>
}

const RETRY_DELAYS_MS = [1000, 3000] // ×2 retries (SPEC §6.2)

export async function callTool(
  egress: EgressClient,
  tool: ToolDef,
  args: unknown,
  timeoutMs: number,
  ctx: ToolCallContext,
): Promise<ToolOutcome> {
  let lastError = 'tool_unreachable'
  const ids = { run_id: ctx.runId, call_id: ctx.callId, tool: tool.name }

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    if (ctx.signal.aborted) return { kind: 'error', error: 'cancelled', status: 'error' }
    const canRetry = attempt <= RETRY_DELAYS_MS.length
    const started = Date.now()

    const body = JSON.stringify({
      contract_version: CONTRACT_VERSION,
      run_id: ctx.runId,
      call_id: ctx.callId,
      attempt,
      origin_request_id: ctx.originRequestId,
      tool: tool.name,
      args,
      meta: ctx.meta,
      result_url: ctx.resultUrl,
    })

    let status: number
    let text: string
    try {
      const res = await egress.request({
        url: tool.endpoint,
        method: 'POST',
        headers: tool.headers,
        body,
        timeoutMs,
        maxBytes: ctx.toolResponseMaxBytes,
        purpose: `tool:${tool.name}`,
        signal: ctx.signal,
      })
      status = res.status
      text = res.text
    } catch (err) {
      const durationMs = Date.now() - started
      if (err instanceof BodyTooLargeError) {
        log.warn('tool_http', { ...ids, attempt, duration_ms: durationMs, error: 'tool_response_too_large' })
        return { kind: 'error', error: 'tool_response_too_large', status: 'protocol_error' }
      }
      if (err instanceof EngineError && err.code === 'egress_denied') {
        log.warn('tool_http', { ...ids, attempt, duration_ms: durationMs, error: `egress_denied: ${err.message}` })
        return { kind: 'error', error: `egress_denied: ${err.message}`, status: 'http_error' }
      }
      if (ctx.signal.aborted) return { kind: 'error', error: 'cancelled', status: 'error' }
      lastError = describeNetworkError(err)
      // a private address is a deterministic refusal (SPEC §11.4): a retry would get the same answer
      if (lastError === 'egress_denied') {
        log.warn('tool_http', { ...ids, attempt, duration_ms: durationMs, error: 'egress_denied: private address' })
        return { kind: 'error', error: 'egress_denied: private address', status: 'http_error' }
      }
      const retry = canRetry && lastError !== 'tool_timeout'
      log.warn('tool_http', { ...ids, attempt, duration_ms: durationMs, error: lastError, retry })
      if (lastError === 'tool_timeout') {
        return { kind: 'error', error: 'tool_timeout', status: 'timeout' }
      }
      if (retry) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]!, ctx.signal)
        continue
      }
      return { kind: 'error', error: lastError, status: 'http_error' }
    }

    const durationMs = Date.now() - started
    if (status >= 500) {
      lastError = `tool_http_${status}`
      log.warn(
        'tool_http',
        { ...ids, attempt, duration_ms: durationMs, http_status: status, retry: canRetry },
        { body: text },
      )
      if (canRetry) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]!, ctx.signal)
        continue
      }
      return { kind: 'error', error: lastError, status: 'http_error' }
    }
    if (status >= 400) {
      // 4xx — no retry (SPEC §6.2)
      log.warn('tool_http', { ...ids, attempt, duration_ms: durationMs, http_status: status }, { body: text })
      return { kind: 'error', error: `tool_http_${status}`, status: 'http_error' }
    }
    log.debug('tool_http', { ...ids, attempt, duration_ms: durationMs, http_status: status })

    return interpretBody(text, tool, ctx, timeoutMs)
  }

  return { kind: 'error', error: lastError, status: 'http_error' }
}

async function interpretBody(
  text: string,
  tool: ToolDef,
  ctx: ToolCallContext,
  timeoutMs: number,
): Promise<ToolOutcome> {
  let parsed: unknown
  if (text.trim().length === 0) {
    parsed = null
  } else {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text // not JSON — the whole body as result
    }
  }

  const envelope = ToolEnvelopeSchema.safeParse(parsed)

  // a write tool must answer deferred (SPEC §6.2, §6.4): any other answer only
  // detects a misconfigured tool; the engine cannot roll back the mutation
  if (tool.effect === 'write' && (!envelope.success || envelope.data.status !== 'deferred')) {
    log.error(
      'tool_protocol_error',
      {
        run_id: ctx.runId,
        call_id: ctx.callId,
        tool: tool.name,
        endpoint: safeUrl(tool.endpoint),
        reason: 'write tool did not answer deferred',
      },
      { body: parsed },
    )
    return { kind: 'error', error: 'tool_protocol_error', status: 'protocol_error' }
  }

  if (!envelope.success) {
    // any other body = result (SPEC §6.2)
    return truncateResult(parsed, ctx.toolResultMaxBytes)
  }

  const value = envelope.data
  switch (value.status) {
    case 'ok':
      return truncateResult(value.result ?? null, ctx.toolResultMaxBytes)

    case 'error':
      return { kind: 'error', error: value.error ?? 'tool error', status: 'error' }

    case 'deferred': {
      if (!value.operation_id) {
        log.warn('tool_protocol_error', {
          run_id: ctx.runId,
          call_id: ctx.callId,
          tool: tool.name,
          reason: 'deferred without operation_id',
        })
        return { kind: 'error', error: 'tool_protocol_error', status: 'protocol_error' }
      }
      return { kind: 'deferred', operationId: value.operation_id }
    }

    case 'accepted': {
      // wait for POST result_url up to tools[].timeout_ms (SPEC §6.2)
      log.info('tool_accepted', { run_id: ctx.runId, call_id: ctx.callId, tool: tool.name, timeout_ms: timeoutMs })
      try {
        const async = await ctx.waitForAsyncResult(ctx.callId, timeoutMs, ctx.signal)
        if (async.is_error) {
          return { kind: 'error', error: async.error ?? 'tool error', status: 'error' }
        }
        return truncateResult(async.result ?? null, ctx.toolResultMaxBytes)
      } catch (err) {
        if (err instanceof ToolWaitTimeout) {
          return { kind: 'error', error: 'tool_timeout', status: 'timeout' }
        }
        return { kind: 'error', error: 'cancelled', status: 'error' }
      }
    }
  }
}

/** Truncates a successful result to limits.tool_result_max_bytes (SPEC §6.2). */
export function truncateResult(result: unknown, maxBytes: number): ToolOutcome {
  let serialized: string
  try {
    serialized = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null')
  } catch {
    serialized = '[unserializable]'
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= maxBytes) return { kind: 'ok', result, truncated: false }

  const cut = Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8')
  return {
    kind: 'ok',
    result: `${cut}…[truncated, ${bytes} bytes total]`,
    truncated: true,
  }
}

export class ToolWaitTimeout extends Error {
  constructor() {
    super('tool_timeout')
    this.name = 'ToolWaitTimeout'
  }
}

function describeNetworkError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (err as { code?: string })?.code
  // fetch wraps the lookup error two or three levels deep ("fetch failed" → connect error →
  // our error), so the private-address code is looked up along the whole cause chain
  if (causeCodes(err).includes('EGRESS_PRIVATE_IP')) return 'egress_denied'
  if (/egress_timeout|timeout|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(message)) return 'tool_timeout'
  return code ? `tool_network_${code}` : 'tool_network_error'
}

function causeCodes(err: unknown): string[] {
  const codes: string[] = []
  for (let e = err, depth = 0; e != null && depth < 6; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    e = (e as { cause?: unknown }).cause
  }
  return codes
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
