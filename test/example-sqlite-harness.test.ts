/**
 * The example harness (examples/sqlite-harness) end to end, without network: the engine with
 * a mock model, the harness as a real HTTP server for tools and the callback, SQLite in memory.
 * Covers the harness obligations of SPEC Appendix A that a first integration usually trips on.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import { createHarness, type Harness } from '../examples/sqlite-harness/harness.js'
import { openStore, type Store } from '../examples/sqlite-harness/store.js'
import { ENGINE_TOKEN, finish, mockFactory, mockModel, START, streamFrom, textChunks, testConfig, toolCall, waitFor } from './helpers.js'

const ENGINE_URL = 'http://engine.test'
const SESSION = 'sess_1'
const USER = 'u_1'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

async function setup(
  model: ReturnType<typeof mockModel>,
  opts: { engineEnv?: Record<string, string>; callbackSecret?: string } = {},
): Promise<{ engine: Engine; harness: Harness; store: Store }> {
  const engine = createEngine(testConfig(opts.engineEnv), { modelFactory: mockFactory(model) })
  cleanup.push(() => engine.shutdown())

  const store = openStore(':memory:')
  store.putOrder({ id: '1042', user_id: USER, status: 'delivered', total: 120, refunded: 0 })
  store.putOrder({ id: '2001', user_id: 'someone-else', status: 'delivered', total: 80, refunded: 0 })

  let harness: Harness | undefined
  const server: Server = createServer((req, res) => void harness!.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const port = (server.address() as AddressInfo).port

  harness = createHarness({
    store,
    engineUrl: ENGINE_URL,
    engineToken: ENGINE_TOKEN,
    publicUrl: `http://127.0.0.1:${port}`,
    ...(opts.callbackSecret ? { callbackSecret: opts.callbackSecret } : {}),
    llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    // the harness talks to the in-process engine; the engine reaches the harness over HTTP
    fetch: ((input: string, init?: RequestInit) => engine.app.request(String(input).replace(ENGINE_URL, ''), init)) as typeof fetch,
  })
  return { engine, harness, store }
}

function roles(store: Store): string[] {
  return store.history(SESSION).map((m) => (m.role === 'tool' ? `tool:${m.error ?? 'ok'}` : m.role))
}

describe('example harness: the whole path', () => {
  it('read tool → write intent → approval → mutation → continuation, every run recorded and acked', async () => {
    const model = mockModel([
      // turn 1: a read tool
      streamFrom([START, toolCall('c1', 'getOrder', { orderId: '1042' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Order 1042 was delivered.'), finish('stop')]),
      // turn 2: a write tool — the run ends awaiting the operation
      streamFrom([START, toolCall('c2', 'refundOrder', { orderId: '1042', amount: 120 }), finish('tool-calls')]),
      // after approval: the continuation run
      streamFrom([START, ...textChunks('Refunded 120.'), finish('stop')]),
    ])
    const { engine, harness, store } = await setup(model)

    const first = await harness.send(SESSION, USER, 'Where is my order 1042?')
    await waitFor(() => store.run(first.runId)?.status === 'completed')
    expect(roles(store)).toEqual(['user', 'assistant', 'tool:ok', 'assistant'])
    expect(store.history(SESSION)[2]!.result).toMatchObject({ orderId: '1042', status: 'delivered' })
    expect(store.session(SESSION, USER)).toMatchObject({ state: 'idle', active_run_id: null })

    const second = await harness.send(SESSION, USER, 'Please refund it.')
    await waitFor(() => store.run(second.runId)?.status === 'awaiting_tool')
    const session = store.session(SESSION, USER)
    expect(session.state).toBe('awaiting_tool')
    expect(session.pending_call_ids).toEqual(['c2'])
    const [op] = harness.pendingApprovals(SESSION)
    expect(op).toMatchObject({ tool: 'refundOrder', status: 'pending', fields: { orderId: '1042', amount: 120 } })
    // the tool call registered an intent and changed nothing
    expect(store.order('1042', USER)!.refunded).toBe(0)

    const next = await harness.decide(op!.id, 'approve', op!.version)
    expect(next).not.toBeNull()
    await waitFor(() => store.run(next!.runId)?.status === 'completed')

    expect(store.order('1042', USER)).toMatchObject({ status: 'refunded', refunded: 120 })
    expect(store.operation(op!.id)!.status).toBe('done')
    expect(roles(store)).toEqual(['user', 'assistant', 'tool:ok', 'assistant', 'user', 'assistant', 'tool:ok', 'assistant'])
    expect(store.history(SESSION)[6]).toMatchObject({ call_id: 'c2', operation_id: op!.id, result: { refunded: 120 } })
    expect(store.session(SESSION, USER).state).toBe('idle')

    // every result reached the harness by callback, and the 2xx was the ack (SPEC §3.1)
    for (const runId of [first.runId, second.runId, next!.runId]) {
      expect(store.run(runId)!.acked).toBe(true)
      expect(engine.deps.registry.get(runId)!.acked).toBe(true)
    }
  })

  it('a duplicate callback or a GET of the same result changes nothing', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('Hello.'), finish('stop')])])
    const { engine, harness, store } = await setup(model)

    const { runId } = await harness.send(SESSION, USER, 'hi')
    await waitFor(() => store.run(runId)?.status === 'completed')
    const before = { history: store.history(SESSION), session: store.session(SESSION, USER) }

    const res = await engine.app.request(`/runs/${runId}`, { headers: { Authorization: `Bearer ${ENGINE_TOKEN}` } })
    harness.applyResult((await res.json()) as never)
    harness.applyResult((await (await engine.app.request(`/runs/${runId}`, { headers: { Authorization: `Bearer ${ENGINE_TOKEN}` } })).json()) as never)

    expect(store.history(SESSION)).toEqual(before.history)
    expect(store.session(SESSION, USER)).toEqual(before.session)
  })
})

describe('example harness: write intents', () => {
  it('the write endpoint is idempotent by origin and by subject fields, and always answers deferred', async () => {
    const { harness } = await setup(mockModel([]))
    const call = (origin: string, args: Record<string, unknown>, user = USER) =>
      callToolOverHttp(harness, 'refundOrder', { call_id: 'x', origin_request_id: origin, args, meta: { session_id: SESSION, user_id: user } })

    const a = await call('msg_1', { orderId: '1042', amount: 120 })
    const replay = await call('msg_1', { orderId: '1042', amount: 120 })
    const sameFields = await call('msg_2', { orderId: '1042', amount: 120 })
    const otherAmount = await call('msg_3', { orderId: '1042', amount: 60 })
    const foreignOrder = await call('msg_4', { orderId: '2001', amount: 80 })

    expect(a.status).toBe('deferred')
    expect(replay.operation_id).toBe(a.operation_id)
    expect(sameFields.operation_id).toBe(a.operation_id)
    expect(otherAmount.operation_id).not.toBe(a.operation_id)
    // another customer's order: still an intent, rejected at once, still deferred
    expect(foreignOrder.status).toBe('deferred')
    expect(harness.store.operation(String(foreignOrder.operation_id))!.status).toBe('rejected')
  })
})

describe('example harness: session rules', () => {
  it('a message during awaiting_tool supersedes the call; the late result comes as an event part', async () => {
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'refundOrder', { orderId: '1042', amount: 120 }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Okay, anything else?'), finish('stop')]),
      streamFrom([START, ...textChunks('The refund went through.'), finish('stop')]),
    ])
    const { harness, store } = await setup(model)

    const first = await harness.send(SESSION, USER, 'Refund order 1042.')
    await waitFor(() => store.run(first.runId)?.status === 'awaiting_tool')
    const [op] = harness.pendingApprovals(SESSION)

    const second = await harness.send(SESSION, USER, 'Actually, tell me about delivery times.')
    await waitFor(() => store.run(second.runId)?.status === 'completed')
    expect(store.history(SESSION).find((m) => m.call_id === 'c1')).toMatchObject({ is_error: true, error: 'superseded' })

    // approved later: the operation lives on, but its call is closed
    expect(await harness.decide(op!.id, 'approve', op!.version)).toBeNull()
    expect(store.order('1042', USER)!.refunded).toBe(120)

    const third = await harness.send(SESSION, USER, 'Thanks.')
    await waitFor(() => store.run(third.runId)?.status === 'completed')
    const lastUser = store.history(SESSION).filter((m) => m.role === 'user').at(-1)!
    expect(lastUser.content[0]).toMatchObject({ type: 'event', name: 'operation_result', data: { operation_id: op!.id } })
  })

  it('a lost callback is recovered by GET at the deadline, then acked', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('Hello.'), finish('stop')])])
    // the engine signs callbacks with a secret the harness does not accept → every callback fails
    const { engine, harness, store } = await setup(model, {
      engineEnv: { CALLBACK_SECRET: 'engine-secret' },
      callbackSecret: 'another-secret',
    })

    const { runId } = await harness.send(SESSION, USER, 'hi')
    await waitFor(() => engine.deps.registry.get(runId)?.result != null)
    expect(store.run(runId)!.status).toBe('running')

    store.setRunStatus(runId, 'running', 0)
    await harness.recover()

    expect(store.run(runId)).toMatchObject({ status: 'completed', acked: true })
    expect(roles(store)).toEqual(['user', 'assistant'])
    expect(engine.deps.registry.get(runId)!.acked).toBe(true)
  })
})

async function callToolOverHttp(harness: Harness, tool: string, body: unknown): Promise<Record<string, unknown>> {
  const server = createServer((req, res) => void harness.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${port}/tools/${tool}`, { method: 'POST', body: JSON.stringify(body) })
    return (await res.json()) as Record<string, unknown>
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
