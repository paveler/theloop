/**
 * Regressions from the implementation review.
 * Each test covers one hole that was found.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult, StoredMessage } from '../src/contracts.js'
import { EngineError } from '../src/errors.js'
import { assertToolInvariant } from '../src/runs/messages.js'
import { UsageTracker, checkBudgets } from '../src/runs/usage.js'
import { validateToolArgs } from '../src/tools/args.js'
import {
  bearer,
  finish,
  hangingStream,
  json,
  mockFactory,
  mockModel,
  parseSse,
  readSseUntil,
  runRequest,
  START,
  startServer,
  streamFrom,
  textChunks,
  testConfig,
  toolCall,
  waitFor,
  type LocalServer,
} from './helpers.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function track(engine: Engine): Engine {
  cleanup.push(() => engine.shutdown())
  return engine
}
function trackServer(server: LocalServer): LocalServer {
  cleanup.push(() => server.close())
  return server
}
async function post(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  return engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
}

describe('an early result of an accepted tool is not lost (SPEC §6.2)', () => {
  it('result_url is called BEFORE the tool answers accepted', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    let engineRef: Engine | null = null
    let runId = ''

    // the tool first posts the result to result_url and only then answers accepted
    const tools = trackServer(
      await startServer(async (body, _req, res) => {
        const call = body as { result_url: string; call_id: string }
        const url = new URL(call.result_url)
        await engineRef!.app.request(url.pathname + url.search, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ call_id: call.call_id, result: { arrived: 'early' } }),
        })
        json(res, 200, { status: 'accepted' })
      }),
    )

    const model = mockModel([
      streamFrom([START, toolCall('c1', 't', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('got it'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    engineRef = engine

    const res = await post(engine, {
      ...runRequest({
        tools: [
          { name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read', timeout_ms: 1500 },
        ] as never,
      }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    runId = ((await res.json()) as { run_id: string }).run_id
    expect(runId).toBeTruthy()

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.status).toBe('completed')
    expect(payload.tool_calls[0]!.status).toBe('ok')
    expect((payload.messages[1] as Record<string, any>).result).toEqual({ arrived: 'early' })
  })
})

describe('invalid tool arguments are not executed (SPEC §6.1)', () => {
  it('args fail input_schema → the endpoint is not called, the model gets an error', async () => {
    const tools = trackServer(
      await startServer((_b, _r, res) => json(res, 200, { status: 'deferred', operation_id: 'op_1' })),
    )
    const model = mockModel([
      // the model forgot the required field amount
      streamFrom([START, toolCall('c1', 'refund', { comment: 'no amount' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('I will ask for the amount'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = (await (
      await post(engine, {
        ...runRequest({
          idempotency_key: 'msg_1',
          history_revision: 1,
          meta: { session_id: 'sess_1' } as never,
          tools: [
            {
              name: 'refund',
              input_schema: {
                type: 'object',
                properties: { amount: { type: 'number' }, comment: { type: 'string' } },
                required: ['amount'],
              },
              endpoint: `${tools.url}/refund`,
              effect: 'write',
            },
          ] as never,
        }),
      })
    ).json()) as RunResult

    expect(tools.requests).toHaveLength(0) // the write endpoint is untouched
    expect(result.status).toBe('completed')
    expect(result.tool_calls[0]!.status).toBe('error')
    const toolMessage = result.messages[1] as Record<string, any>
    expect(toolMessage.is_error).toBe(true)
    expect(toolMessage.error).toBe('invalid_tool_input: arguments: missing required field "amount"')
  })

  it('unparsable arguments JSON → the same rejection, the run continues', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: {} })))
    const model = mockModel([
      streamFrom([
        START,
        { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: '{"a":' },
        finish('tool-calls'),
      ]),
      streamFrom([START, ...textChunks('retrying'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = (await (
      await post(
        engine,
        runRequest({
          tools: [{ name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read' }] as never,
        }),
      )
    ).json()) as RunResult

    expect(tools.requests).toHaveLength(0)
    expect((result.messages[1] as Record<string, any>).error).toMatch(/^invalid_tool_input:/)
    expect(result.status).toBe('completed')
  })

  it('the validator is conservative: unknown schema constructs do not reject a call', () => {
    expect(validateToolArgs({ type: 'object', required: ['a'] }, { a: 1 })).toEqual({ ok: true })
    expect(validateToolArgs({ type: 'object', required: ['a'] }, {}).ok).toBe(false)
    expect(validateToolArgs({ anyOf: [{ type: 'string' }, { type: 'number' }] }, { anything: 'goes' })).toEqual({
      ok: true,
    })
    expect(validateToolArgs({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 1.5 }).ok).toBe(false)
    expect(validateToolArgs({ type: 'object', properties: { s: { enum: ['a', 'b'] } } }, { s: 'c' }).ok).toBe(false)
    expect(validateToolArgs(undefined, { anything: 'goes' })).toEqual({ ok: true })
  })
})

describe('the browser cannot bypass stream.expose_* via cancel (SPEC §4.4)', () => {
  it('messages are withheld with the run token and returned with ENGINE_TOKEN', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream([START, ...textChunks('typing')], abortSignal),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const stream = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    await readSseUntil(stream, (b) => b.includes('typing'))

    const browser = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    const browserBody = (await browser.json()) as Record<string, unknown>
    expect(browser.status).toBe(200)
    expect(browserBody.status).toBe('cancelled')
    expect(browserBody.messages).toBeUndefined()
    expect(browserBody.usage).toBeDefined()
    expect(browserBody.tool_calls).toBeDefined()

    const server = await engine.app.request(`/runs/${run_id}/cancel`, { method: 'POST', headers: bearer() })
    const serverBody = (await server.json()) as RunResult
    expect(serverBody.messages).toHaveLength(1)
  })
})

describe('SSE: subscribers do not leak (SPEC §6.6, §11.5)', () => {
  it('after done the subscribers are removed and no ping timers remain', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const model = mockModel([streamFrom([START, ...textChunks('done'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const stream = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    const events = parseSse(await readSseUntil(stream, (b) => b.includes('event: done')))
    expect(events.some((e) => e.event === 'done')).toBe(true)

    const hub = engine.deps.registry.get(run_id)!.sse as unknown as { subscribers: Set<unknown> }
    expect(hub.subscribers.size).toBe(0)
  })
})

describe('the request body is limited before it is read into memory (SPEC §4)', () => {
  it('a chunked request without Content-Length is rejected by MAX_REQUEST_BYTES', async () => {
    const engine = track(createEngine(testConfig({ MAX_REQUEST_BYTES: '1024' })))
    const big = JSON.stringify(runRequest({ system: 'x'.repeat(4000) }))

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big)
        for (let i = 0; i < bytes.length; i += 256) controller.enqueue(bytes.slice(i, i + 256))
        controller.close()
      },
    })

    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer test-engine-token`, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    })
    expect(res.status).toBe(413)
  })
})

describe('the budget reserves max_tokens for an unknown attempt (SPEC §10.2.3)', () => {
  it('usage gets the actual estimate, the budget gets the worst case', () => {
    const tracker = new UsageTracker(null)
    tracker.record({
      status: 'unknown',
      provider: 'anthropic',
      model: 'm',
      tokens: {
        input_tokens: 1000,
        output_tokens: 5, // almost no text received
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
      finishReason: null,
      durationMs: 10,
      providerRequestId: null,
      estimated: true,
      reservedOutput: 4096,
    })

    expect(tracker.total().output_tokens).toBe(5) // reporting: what was seen
    expect(tracker.spentTokens()).toBe(1000 + 4096) // budget: the worst case

    const verdict = checkBudgets(
      tracker,
      { input: 1000, cacheWrite: 0, cacheRead: 0, output: 4096 },
      { max_total_tokens: 9000 },
    )
    expect(verdict).toEqual({ ok: false, exceeded: 'max_total_tokens' })
  })
})

describe('history invariant: order and tool name (SPEC §5)', () => {
  const call = (callId: string, tool: string): StoredMessage => ({
    role: 'assistant',
    content: [{ type: 'tool_call', call_id: callId, tool, args: {} }],
  })
  const result = (callId: string, tool: string): StoredMessage => ({
    role: 'tool',
    call_id: callId,
    tool,
    result: {},
    is_error: false,
  })
  const user: StoredMessage = { role: 'user', content: [{ type: 'text', text: 'go' }] }

  it('a correct pair passes', () => {
    expect(() => assertToolInvariant([user, call('c1', 't'), result('c1', 't')])).not.toThrow()
  })

  it('a result before its call is rejected', () => {
    expect(() => assertToolInvariant([user, result('c1', 't'), call('c1', 't')])).toThrowError(EngineError)
  })

  it('a mismatched tool name is rejected', () => {
    expect(() => assertToolInvariant([user, call('c1', 't'), result('c1', 'other')])).toThrowError(EngineError)
  })

  it('two results for one call_id are rejected', () => {
    expect(() =>
      assertToolInvariant([user, call('c1', 't'), result('c1', 't'), result('c1', 't')]),
    ).toThrowError(EngineError)
  })

  it('a call_id duplicated across two turns is rejected', () => {
    expect(() =>
      assertToolInvariant([user, call('c1', 't'), result('c1', 't'), call('c1', 't'), result('c1', 't')]),
    ).toThrowError(EngineError)
  })
})

describe('expires_at is accurate after ack (SPEC §4.8, §11.5)', () => {
  it('after ack the expiry is recomputed from RUN_RETENTION_MS', async () => {
    const engine = track(
      createEngine(testConfig({ RUN_RETENTION_MS: '1000', RUN_RETENTION_UNACKED_MS: '3600000' }), {
        modelFactory: mockFactory(mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))),
      }),
    )

    const res = await post(engine, runRequest({ meta: { session_id: 'sess_exp' } as never }))
    const body = (await res.json()) as RunResult
    const unacked = Date.parse(body.expires_at)

    await engine.app.request(`/runs/${body.run_id}/ack`, { method: 'POST', headers: bearer() })
    const after = (await (
      await engine.app.request(`/runs/${body.run_id}`, { headers: bearer() })
    ).json()) as RunResult

    const acked = Date.parse(after.expires_at)
    expect(acked).toBeLessThan(unacked)
    const record = engine.deps.registry.get(body.run_id)!
    expect(acked).toBe(record.expiresAt)
  })
})
