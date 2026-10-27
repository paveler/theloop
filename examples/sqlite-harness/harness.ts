/**
 * A complete harness for theloop in one file: what a backend has to do around the engine
 * (SPEC Appendix A). It owns the history, starts runs, applies results idempotently, serves a
 * read tool and a write tool, runs approvals and continues the conversation, and recovers runs
 * whose callback never came.
 *
 * Demo domain: a help desk of an online store — `getOrder` (read) and `refundOrder` (write,
 * needs approval).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Operation, Session, Store } from './store.js'

export interface HarnessOptions {
  store: Store
  /** Base URL of the engine, e.g. http://localhost:8080. */
  engineUrl: string
  engineToken: string
  /** Base URL where the engine reaches this harness: tools and the callback. */
  publicUrl: string
  /** Must match the engine's CALLBACK_SECRET, if it has one (SPEC §7). */
  callbackSecret?: string
  llm: { provider: string; model: string }
  system?: string
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch
}

/** The parts of the run result (SPEC §7) this harness reads. */
interface RunResult {
  run_id: string
  status: 'completed' | 'stopped_limit' | 'awaiting_tool' | 'cancelled' | 'failed'
  history_revision?: number
  meta: { session_id?: string }
  messages: Array<Record<string, any> & { seq: number }>
  tool_calls: Array<{ call_id: string; status: string; operation_id: string | null }>
  error: { code: string; message: string } | null
}

/** How long past `timeout_ms` to wait for the callback before asking the engine (SPEC §3). */
const DEADLINE_SLACK_MS = 120_000
const RUN_TIMEOUT_MS = 120_000

const SYSTEM =
  'You are the help desk assistant of an online store. Use the tools to look up orders. ' +
  'Refunds need the customer to confirm a card in the UI: request one with refundOrder and ' +
  'tell the customer to confirm it.'

export function createHarness(options: HarnessOptions) {
  const { store } = options
  const doFetch = options.fetch ?? fetch

  /* ------------------------------------------------------------ engine API */

  async function engine(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return doFetch(`${options.engineUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${options.engineToken}`, 'Content-Type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  }

  function tools() {
    return [
      {
        name: 'getOrder',
        description: 'Status and totals of an order of the current customer.',
        input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
        endpoint: `${options.publicUrl}/tools/getOrder`,
        effect: 'read',
      },
      {
        name: 'refundOrder',
        description: 'Request a refund for an order. The customer must confirm it; the result comes later.',
        input_schema: {
          type: 'object',
          properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
          required: ['orderId', 'amount'],
        },
        endpoint: `${options.publicUrl}/tools/refundOrder`,
        effect: 'write',
      },
    ]
  }

  /**
   * POST /runs for the current history. Write tools need idempotency_key, meta.session_id and
   * history_revision (SPEC §4.2). A previous result that is not recorded yet is fetched,
   * recorded and acked first (SPEC §3.1).
   */
  async function startRun(session: Session, idempotencyKey: string): Promise<{ runId: string; streamUrl: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await engine('/runs', {
        method: 'POST',
        body: {
          contract_version: '1',
          idempotency_key: idempotencyKey,
          history_revision: session.history_revision,
          llm: options.llm,
          system: options.system ?? SYSTEM,
          messages: store.history(session.id),
          tools: tools(),
          limits: { max_steps: 6, timeout_ms: RUN_TIMEOUT_MS },
          callback: { url: `${options.publicUrl}/callback` },
          meta: { session_id: session.id, user_id: session.user_id },
        },
      })
      const body = (await res.json()) as Record<string, any>
      if (res.status === 202 || res.status === 200) {
        store.transaction(() => {
          store.putRun(body.run_id, session.id, Date.now() + RUN_TIMEOUT_MS + DEADLINE_SLACK_MS)
          session.state = 'running'
          session.active_run_id = body.run_id
          store.saveSession(session)
        })
        // the callback beat this response: the result is recorded, the session can move on now
        const early = store.run(body.run_id)?.result
        if (early) applyResult(early as RunResult)
        return { runId: body.run_id, streamUrl: body.stream_url }
      }
      const code = body.error?.code
      if (res.status === 409 && code === 'result_pending') {
        await fetchAndApply(body.error.pending_run_id)
      } else if (res.status === 409 && code === 'session_busy') {
        await cancel(body.error.active_run_id)
      } else {
        throw new Error(`POST /runs: ${res.status} ${JSON.stringify(body)}`)
      }
      session = store.session(session.id, session.user_id)
    }
    throw new Error('POST /runs: the session stayed locked')
  }

  /** GET /runs/{id} → record → ack. 404 means lost (SPEC §3, §4.6). */
  async function fetchAndApply(runId: string): Promise<'applied' | 'running' | 'lost'> {
    const res = await engine(`/runs/${runId}`)
    if (res.status === 404) {
      markLost(runId)
      return 'lost'
    }
    const result = (await res.json()) as RunResult
    if (result.status === ('running' as string) || result.status === ('cancelling' as string)) return 'running'
    applyResult(result)
    await ack(runId)
    return 'applied'
  }

  async function ack(runId: string): Promise<void> {
    const res = await engine(`/runs/${runId}/ack`, { method: 'POST' })
    if (res.ok) store.markAcked(runId)
  }

  /** Interrupt: cancel is synchronous and returns the result (SPEC §4.4, §6.5). */
  async function cancel(runId: string): Promise<void> {
    const res = await engine(`/runs/${runId}/cancel`, { method: 'POST' })
    if (res.status === 200) {
      applyResult((await res.json()) as RunResult)
      await ack(runId)
    } else {
      // 202 cancelling: the result comes by callback or by GET
      await fetchAndApply(runId)
    }
  }

  function markLost(runId: string): void {
    const run = store.run(runId)
    if (!run) return
    store.transaction(() => {
      store.setRunStatus(runId, 'lost')
      const session = store.session(run.session_id, '')
      if (session.active_run_id === runId) {
        session.state = 'idle'
        session.active_run_id = null
        store.saveSession(session)
      }
    })
  }

  /* --------------------------------------------------------- run results */

  /**
   * Records a result. Safe to call any number of times for one run: the callback, GET and
   * cancel may all deliver it (SPEC §3.1 rule 5). A late result for an older history revision
   * is kept as audit and never appended as an assistant turn (SPEC §3).
   */
  function applyResult(result: RunResult): void {
    const run = store.run(result.run_id)
    const sessionId = run?.session_id ?? result.meta.session_id
    if (!sessionId) return
    let settled: Operation[] = []
    store.transaction(() => {
      const session = store.session(sessionId, '')
      const current = result.history_revision === session.history_revision
      for (const message of result.messages) {
        store.putMessage(`${result.run_id}:${message.seq}`, sessionId, message, !current)
      }
      store.setRunResult(result.run_id, sessionId, result.status, result)
      // a deferred call closed by cancel: its approval must not execute any more (SPEC §6.5, H21)
      for (const c of result.tool_calls) {
        const op = c.status === 'cancelled' && c.operation_id ? store.operation(c.operation_id) : null
        if (op?.status !== 'pending') continue
        op.status = 'rejected'
        op.result = { error: 'cancelled' }
        store.putOperation(op)
      }
      // only the first application moves the session on
      if (!current || session.active_run_id !== result.run_id) return
      session.active_run_id = null
      session.history_revision += 1
      if (result.status === 'awaiting_tool') {
        session.state = 'awaiting_tool'
        session.pending_call_ids = result.tool_calls.filter((c) => c.status === 'deferred').map((c) => c.call_id)
        // an operation can be closed already: rejected at registration, or executed before a
        // replay found it by origin (SPEC §6.4) — no decision will come for it
        settled = result.tool_calls
          .map((c) => (c.status === 'deferred' && c.operation_id ? store.operation(c.operation_id) : null))
          .filter((op): op is Operation => op != null && op.status !== 'pending')
      } else {
        session.state = 'idle'
      }
      store.saveSession(session)
    })
    for (const op of settled) void continueAfter(op).catch((err) => console.error('continue:', err))
  }

  /* --------------------------------------------------------------- turns */

  /** A new user message: SPEC §3.1 — interrupt or supersede first, then a new run. */
  async function send(sessionId: string, userId: string, text: string): Promise<{ runId: string; streamUrl: string }> {
    let session = store.session(sessionId, userId)
    if (session.state === 'running' && session.active_run_id) {
      await cancel(session.active_run_id)
      session = store.session(sessionId, userId)
    }
    const messageId = `msg_${randomUUID()}`
    store.transaction(() => {
      if (session.state === 'awaiting_tool') {
        // the operation lives on; its result will come as an event part (SPEC §3.1 rule 3)
        for (const callId of session.pending_call_ids) {
          const call = findToolCall(session.id, callId)
          store.putMessage(callId, session.id, {
            role: 'tool',
            call_id: callId,
            tool: call?.tool ?? 'unknown',
            is_error: true,
            error: 'superseded',
          })
        }
        session.pending_call_ids = []
        session.state = 'idle'
      }
      store.putMessage(messageId, session.id, {
        role: 'user',
        content: [...session.pending_events, { type: 'text', text }],
        created_at: new Date().toISOString(),
      })
      session.pending_events = []
      session.history_revision += 1
      store.saveSession(session)
    })
    return startRun(session, messageId)
  }

  /* ---------------------------------------------------------------- tools */

  /** The engine POSTs every tool call here (SPEC §6.1). */
  function callTool(name: string, call: Record<string, any>): Record<string, unknown> {
    const userId = String(call.meta?.user_id ?? '')
    const sessionId = String(call.meta?.session_id ?? '')
    if (name === 'getOrder') {
      // data is scoped by meta, never by ids from args alone: the model can put any id there
      const order = store.order(String(call.args?.orderId ?? ''), userId)
      return order
        ? { status: 'ok', result: { orderId: order.id, status: order.status, total: order.total, refunded: order.refunded } }
        : { status: 'error', error: 'order not found' }
    }
    if (name === 'refundOrder') return registerRefund(sessionId, userId, call)
    return { status: 'error', error: `unknown tool ${name}` }
  }

  /**
   * A write endpoint only registers an intent and always answers deferred (SPEC §6.4):
   * look up by origin → compare with pending operations → create. It changes nothing.
   */
  function registerRefund(sessionId: string, userId: string, call: Record<string, any>): Record<string, unknown> {
    const fields = { orderId: String(call.args?.orderId ?? ''), amount: Number(call.args?.amount ?? 0) }
    const key = sha256(`${sessionId}|refundOrder|${call.origin_request_id}`)
    return store.transaction(() => {
      const known = store.operationByRef(`opref_${key}`)
      if (known) return { status: 'deferred', operation_id: known.id }

      // the subject of a refund is the order; a new amount updates the pending operation and
      // bumps its version, so a card for the old amount can no longer be confirmed
      const same = store.pendingOperations(sessionId, 'refundOrder').find((op) => op.fields.orderId === fields.orderId)
      if (same) {
        if (same.fields.amount !== fields.amount) {
          same.fields = fields
          same.version += 1
          store.putOperation(same)
        }
        store.putOpref(`opref_${key}`, same.id)
        return { status: 'deferred', operation_id: same.id }
      }

      // an order of another customer is still an intent — rejected at once, answered deferred
      const order = store.order(fields.orderId, userId)
      const op: Operation = {
        id: `op_${key}`,
        session_id: sessionId,
        tool: 'refundOrder',
        status: order ? 'pending' : 'rejected',
        fields,
        version: 1,
        result: order ? null : { error: 'order not found' },
      }
      store.putOperation(op)
      store.putOpref(`opref_${key}`, op.id)
      return { status: 'deferred', operation_id: op.id }
    })
  }

  /* ----------------------------------------------------------- approvals */

  function pendingApprovals(sessionId: string): Operation[] {
    return store.pendingOperations(sessionId)
  }

  /**
   * The user confirmed or rejected a card. The mutation happens here, after approval, with the
   * operation id as the downstream idempotency key — never inside a tool call (SPEC §6.4).
   */
  async function decide(
    operationId: string,
    decision: 'approve' | 'reject',
    version: number,
  ): Promise<{ runId: string; streamUrl: string } | null> {
    const op = store.operation(operationId)
    if (!op) throw new Error(`unknown operation ${operationId}`)
    if (op.status !== 'pending') return null
    if (op.version !== version) throw new Error('the operation changed, refresh the card')
    if (decision === 'approve') {
      store.refund(op.id, op.fields.orderId, op.fields.amount)
      op.status = 'done'
      op.result = { refunded: op.fields.amount, orderId: op.fields.orderId }
    } else {
      op.status = 'rejected'
      op.result = { error: 'rejected by the user' }
    }
    store.putOperation(op)
    return continueAfter(op)
  }

  /**
   * Writes the operation result as the tool result of its call (id = call_id) and, once every
   * deferred call of the turn has one, continues with a new run (SPEC §3.1 rule 4, §6.4).
   */
  async function continueAfter(op: Operation): Promise<{ runId: string; streamUrl: string } | null> {
    const session = store.session(op.session_id, '')
    const callId = session.pending_call_ids.find((id) => findToolCall(session.id, id)?.operation_id === op.id)
    if (!callId) {
      // superseded meanwhile: deliver it with the next user message
      session.pending_events.push({ type: 'event', name: 'operation_result', data: { operation_id: op.id, tool: op.tool, result: op.result } })
      store.saveSession(session)
      return null
    }
    const failed = op.status !== 'done'
    store.transaction(() => {
      store.putMessage(callId, session.id, {
        role: 'tool',
        call_id: callId,
        tool: op.tool,
        operation_id: op.id,
        ...(failed ? { is_error: true, error: String((op.result as { error?: string })?.error ?? 'failed') } : { is_error: false, result: op.result }),
      })
      session.pending_call_ids = session.pending_call_ids.filter((id) => id !== callId)
      if (session.pending_call_ids.length === 0) {
        session.state = 'idle'
        session.history_revision += 1
      }
      store.saveSession(session)
    })
    if (session.pending_call_ids.length > 0) return null
    return startRun(session, `cont_${op.id}`)
  }

  function findToolCall(sessionId: string, callId: string): { tool: string; operation_id?: string } | null {
    for (const message of store.history(sessionId)) {
      if (message.role !== 'assistant') continue
      for (const part of message.content ?? []) {
        if (part.type === 'tool_call' && part.call_id === callId) return part
      }
    }
    return null
  }

  /* ------------------------------------------------------------ recovery */

  /** Runs past their deadline without a callback: ask the engine before declaring them lost (SPEC §3). */
  async function recover(now = Date.now()): Promise<void> {
    for (const run of store.overdueRuns(now)) {
      const outcome = await fetchAndApply(run.id)
      if (outcome === 'running') store.setRunStatus(run.id, 'running', now + 60_000)
    }
  }

  /* ---------------------------------------------------------------- HTTP */

  /** node:http handler for the routes the engine calls: tools and the callback. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const url = new URL(req.url ?? '/', 'http://harness')
    if (req.method === 'POST' && url.pathname === '/callback') {
      if (options.callbackSecret && req.headers['x-engine-secret'] !== options.callbackSecret) {
        return send401(res)
      }
      // 2xx only after the durable write: that is the ack (SPEC §3.1)
      applyResult((body as { payload: RunResult }).payload)
      store.markAcked((body as { payload: RunResult }).payload.run_id)
      return json(res, 200, { ok: true })
    }
    const tool = /^\/tools\/([A-Za-z]+)$/.exec(url.pathname)
    if (req.method === 'POST' && tool) return json(res, 200, callTool(tool[1]!, body as Record<string, any>))
    json(res, 404, { error: 'not found' })
  }

  return { send, decide, pendingApprovals, recover, handle, applyResult, startRun, store }
}

export type Harness = ReturnType<typeof createHarness>

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function send401(res: ServerResponse): void {
  json(res, 401, { error: 'bad X-Engine-Secret' })
}
