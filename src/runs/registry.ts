/**
 * In-memory run registry (SPEC §3, §11.2, §11.5).
 *
 * Lives here: status, SSE buffer, run and call tokens, the session lock (held UNTIL ack),
 * the idempotency map, pending async calls, retention and eviction.
 * No database: a run is an ephemeral object, all dialogue state lives in the harness.
 */
import type { Config } from '../config.js'
import type { RunRequest, RunResult, RunStatus, Usage } from '../contracts.js'
import { EngineError } from '../errors.js'
import { hashBody, newToken, timingSafeEqualStr } from '../ids.js'
import { sendAlert } from '../alerts.js'
import { log } from '../log.js'
import { SseHub } from '../stream/sse.js'
import { ToolWaitTimeout, type AsyncToolResult } from '../tools/http.js'

export type CallState = 'open' | 'resolved' | 'closed'

export interface CallRecord {
  callId: string
  token: string
  tool: string
  state: CallState
  resultHash: string | null
  /**
   * A result that arrived on result_url BEFORE the tool managed to answer accepted.
   * Without this buffer the early answer was lost and the call ran on until tool_timeout.
   * Kept only until consumed or the call closes: resultHash is enough for duplicates,
   * and the body (up to MAX_REQUEST_BYTES) would otherwise hang around for the whole
   * retention, outside MAX_RETAINED_BYTES (SPEC §11.5).
   */
  deliveredResult: AsyncToolResult | null
  waiter: {
    resolve: (r: AsyncToolResult) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null
}

export interface DeliveryState {
  url: string | null
  headers: Record<string, string> | null
  status: 'none' | 'pending' | 'delivered' | 'failed'
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
}

export interface RunRecord {
  runId: string
  status: RunStatus
  token: string
  sessionId: string | null
  idempotencyKey: string | null
  requestHash: string | null
  historyRevision: number | string | null
  meta: Record<string, unknown>
  startedAt: number
  startedAtIso: string
  finishedAt: number | null
  expiresAt: number | null
  acked: boolean

  /** The live request; cleared on terminal status (SPEC §11.5, phase 2). */
  request: RunRequest | null

  abort: AbortController
  /** Abort reason: user / shutdown / run_timeout. */
  abortReason: 'user' | 'shutdown' | 'run_timeout' | null

  sse: SseHub
  steps: number
  /** Live usage while the run is in progress (for GET on a running run). */
  liveUsage: () => Usage

  result: RunResult | null
  resultBytes: number
  delivery: DeliveryState
  /** Callback delivery promise — graceful shutdown needs it to wait. */
  deliveryPromise: Promise<void> | null
  /** Provider-side cleanup after terminal status (GigaChat files, SPEC §5.3) — shutdown waits for it too. */
  releasePromise: Promise<void> | null

  calls: Map<string, CallRecord>
  callTokens: Map<string, string>

  terminal: Promise<void>
  resolveTerminal: () => void
}

const EMPTY_USAGE: Usage = {
  calls: [],
  total: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    calls: 0,
    unknown_calls: 0,
    estimated: false,
  },
}

export function isTerminal(status: RunStatus): boolean {
  return status !== 'running' && status !== 'cancelling'
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>()
  private readonly byIdempotency = new Map<string, string>()
  /** session_id → run_id; released only on ack or when the run is deleted (SPEC §3.1). */
  private readonly sessionLocks = new Map<string, string>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: Config) {}

  startSweeper(intervalMs = 5000): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), intervalMs)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  get size(): number {
    return this.runs.size
  }

  get activeCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (!isTerminal(run.status)) n++
    return n
  }

  get retainedCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (isTerminal(run.status)) n++
    return n
  }

  get retainedBytes(): number {
    let n = 0
    for (const run of this.runs.values()) if (isTerminal(run.status)) n += run.resultBytes
    return n
  }

  all(): IterableIterator<RunRecord> {
    return this.runs.values()
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId)
  }

  findByIdempotencyKey(key: string): RunRecord | undefined {
    const runId = this.byIdempotency.get(key)
    return runId ? this.runs.get(runId) : undefined
  }

  sessionLockHolder(sessionId: string): RunRecord | undefined {
    const runId = this.sessionLocks.get(sessionId)
    return runId ? this.runs.get(runId) : undefined
  }

  /**
   * Makes room for a new run: the oldest acked runs are evicted.
   * Non-acked runs are never evicted before their retention — part of the recovery
   * contract (SPEC §11.5). Filled with non-acked runs only → 429 overloaded.
   */
  ensureCapacity(): void {
    if (this.activeCount >= this.config.maxConcurrentRuns) {
      throw new EngineError('overloaded', 'too many active runs')
    }
    this.evictAcked()
    if (
      this.retainedCount >= this.config.maxRetainedRuns ||
      this.retainedBytes >= this.config.maxRetainedBytes
    ) {
      log.warn('retained_full', { retained: this.retainedCount, bytes: this.retainedBytes })
      throw new EngineError('overloaded', 'retained result memory is full of non-acked runs')
    }
  }

  private evictAcked(): void {
    while (
      this.retainedCount >= this.config.maxRetainedRuns ||
      this.retainedBytes >= this.config.maxRetainedBytes
    ) {
      let oldest: RunRecord | null = null
      for (const run of this.runs.values()) {
        if (!isTerminal(run.status) || !run.acked) continue
        if (!oldest || (run.finishedAt ?? 0) < (oldest.finishedAt ?? 0)) oldest = run
      }
      if (!oldest) return
      this.delete(oldest.runId, 'evicted')
    }
  }

  create(params: {
    runId: string
    request: RunRequest
    requestHash: string
    sessionId: string | null
    liveUsage: () => Usage
  }): RunRecord {
    const now = Date.now()
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })

    const record: RunRecord = {
      runId: params.runId,
      status: 'running',
      token: newToken(),
      sessionId: params.sessionId,
      idempotencyKey: params.request.idempotency_key ?? null,
      requestHash: params.requestHash,
      historyRevision: params.request.history_revision ?? null,
      meta: params.request.meta,
      startedAt: now,
      startedAtIso: new Date(now).toISOString(),
      finishedAt: null,
      expiresAt: null,
      acked: false,
      request: params.request,
      abort: new AbortController(),
      abortReason: null,
      sse: new SseHub(this.config.sseBufferMaxBytes),
      steps: 0,
      liveUsage: params.liveUsage,
      result: null,
      resultBytes: 0,
      deliveryPromise: null,
      releasePromise: null,
      delivery: {
        url: params.request.callback?.url ?? null,
        headers: params.request.callback?.headers ?? null,
        status: params.request.callback ? 'pending' : 'none',
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      },
      calls: new Map(),
      callTokens: new Map(),
      terminal,
      resolveTerminal,
    }

    this.runs.set(record.runId, record)
    if (record.idempotencyKey) this.byIdempotency.set(record.idempotencyKey, record.runId)
    if (record.sessionId) this.sessionLocks.set(record.sessionId, record.runId)
    return record
  }

  /** Terminal status: drop secrets and history, set retention (SPEC §11.5). */
  markTerminal(run: RunRecord, result: RunResult): void {
    run.status = result.status
    run.finishedAt = Date.now()
    run.result = result
    // the SSE hub snapshot (text, reasoning) outlives the terminal status along with the result
    run.resultBytes = estimateBytes(result) + run.sse.snapshotBytes
    // phase 2: api_key, tool headers, system, schemas and the original history go away
    run.request = null
    run.expiresAt = run.finishedAt + this.retentionFor(run)
    for (const call of run.calls.values()) this.closeCall(call)
    run.resolveTerminal()
  }

  private retentionFor(run: RunRecord): number {
    return run.acked ? this.config.runRetentionMs : this.config.runRetentionUnackedMs
  }

  /** ack: the harness recorded the result in the history — release the session lock (SPEC §3.1). */
  ack(run: RunRecord, via: 'callback' | 'endpoint' | 'wait'): void {
    if (run.acked) return
    run.acked = true
    log.info('ack', { run_id: run.runId, session_id: run.sessionId, via })
    if (run.sessionId && this.sessionLocks.get(run.sessionId) === run.runId) {
      this.sessionLocks.delete(run.sessionId)
    }
    if (run.finishedAt) {
      run.expiresAt = run.finishedAt + this.config.runRetentionMs
      // the result body is served by GET — its expires_at must be accurate
      if (run.result) run.result.expires_at = new Date(run.expiresAt).toISOString()
    }
  }

  delete(runId: string, reason: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    if (!run.acked && isTerminal(run.status)) {
      log.warn('ack_missing', { run_id: runId, session_id: run.sessionId, reason })
      sendAlert('ack_missing', { run_id: runId, session_id: run.sessionId, meta: run.meta, status: run.status, reason })
    }
    log.debug('run_deleted', { run_id: runId, reason, acked: run.acked, status: run.status })
    run.sse.close()
    for (const call of run.calls.values()) this.closeCall(call)
    if (run.idempotencyKey && this.byIdempotency.get(run.idempotencyKey) === runId) {
      this.byIdempotency.delete(run.idempotencyKey)
    }
    if (run.sessionId && this.sessionLocks.get(run.sessionId) === runId) {
      this.sessionLocks.delete(run.sessionId)
    }
    this.runs.delete(runId)
  }

  sweep(now = Date.now()): void {
    for (const run of [...this.runs.values()]) {
      if (run.expiresAt != null && run.expiresAt <= now) this.delete(run.runId, 'retention')
    }
  }

  /* ----------------------------------------------------------- tool calls */

  registerCall(run: RunRecord, callId: string, tool: string): CallRecord {
    const token = newToken()
    const call: CallRecord = {
      callId,
      token,
      tool,
      state: 'open',
      resultHash: null,
      deliveredResult: null,
      waiter: null,
    }
    run.calls.set(callId, call)
    run.callTokens.set(token, callId)
    return call
  }

  closeCall(call: CallRecord): void {
    call.deliveredResult = null
    if (call.waiter) {
      clearTimeout(call.waiter.timer)
      call.waiter.reject(new ToolWaitTimeout())
      call.waiter = null
    }
    if (call.state === 'open') call.state = 'closed'
  }

  /** Waits for the async result after status: accepted (SPEC §6.2). */
  awaitCallResult(
    run: RunRecord,
    callId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AsyncToolResult> {
    const call = run.calls.get(callId)
    if (!call) return Promise.reject(new ToolWaitTimeout())
    // the result may have arrived before the tool answered accepted (SPEC §6.2)
    if (call.deliveredResult) {
      const early = call.deliveredResult
      call.deliveredResult = null
      return Promise.resolve(early)
    }
    return new Promise<AsyncToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        call.waiter = null
        call.state = 'closed'
        reject(new ToolWaitTimeout())
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        call.waiter = null
        call.state = 'closed'
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      call.waiter = {
        resolve: (value) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
      }
    })
  }

  /** POST /runs/{id}/tool-result — duplicate semantics per SPEC §4.5. */
  submitToolResult(
    run: RunRecord,
    body: { call_id: string; result?: unknown; error?: string; is_error?: boolean },
  ): { accepted: true; duplicate?: true } {
    const call = run.calls.get(body.call_id)
    if (!call) {
      log.warn('tool_result_received', { run_id: run.runId, call_id: body.call_id, rejected: 'call_not_found' })
      throw new EngineError('call_not_found', 'unknown call_id')
    }

    const hash = hashBody({
      result: body.result ?? null,
      error: body.error ?? null,
      is_error: body.is_error ?? false,
    })

    const ids = { run_id: run.runId, call_id: call.callId, tool: call.tool }
    if (call.resultHash) {
      if (timingSafeEqualStr(call.resultHash, hash)) {
        log.info('tool_result_received', { ...ids, duplicate: true })
        return { accepted: true, duplicate: true }
      }
      log.warn('tool_result_received', { ...ids, rejected: 'result_mismatch' })
      throw new EngineError('result_mismatch', 'a different result was already accepted for this call_id')
    }
    if (call.state === 'closed') {
      log.warn('tool_result_received', { ...ids, rejected: 'call_closed' })
      throw new EngineError('call_closed', 'call is closed: timeout or terminal run status')
    }

    call.resultHash = hash
    call.state = 'resolved'
    const payload: AsyncToolResult = {
      result: body.result,
      error: body.error,
      is_error: body.is_error ?? body.error != null,
    }
    log.info(
      'tool_result_received',
      { ...ids, is_error: payload.is_error, early: call.waiter == null },
      payload.is_error ? { error: payload.error } : { result: payload.result },
    )
    if (call.waiter) {
      const waiter = call.waiter
      call.waiter = null
      waiter.resolve(payload)
    } else {
      call.deliveredResult = payload // early: the tool has not answered accepted yet
    }
    return { accepted: true }
  }

  callByToken(run: RunRecord, token: string): CallRecord | undefined {
    const callId = run.callTokens.get(token)
    return callId ? run.calls.get(callId) : undefined
  }

  emptyUsage(): Usage {
    return structuredClone(EMPTY_USAGE)
  }
}

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}
