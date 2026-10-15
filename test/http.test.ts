/**
 * In-process HTTP e2e (SPEC §13.3): Hono app.request plus local tool and
 * callback servers. No outbound network and no provider keys.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { RunRegistry } from '../src/runs/registry.js'
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

function track<T extends { shutdown: () => Promise<void> }>(engine: T): T {
  cleanup.push(() => engine.shutdown())
  return engine
}
function trackServer(server: LocalServer): LocalServer {
  cleanup.push(() => server.close())
  return server
}

async function okCallbacks(): Promise<LocalServer> {
  return trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
}

async function post(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  return engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
}

describe('POST /runs → SSE → callback', () => {
  it('full cycle: 202, a stream with text, a callback with the result', async () => {
    const callbacks = await okCallbacks()
    const model = mockModel([streamFrom([START, ...textChunks('Done.'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest(),
      wait: false,
      callback: { url: `${callbacks.url}/cb`, headers: { Authorization: 'Bearer harness' } },
    })
    expect(res.status).toBe(202)
    const accepted = (await res.json()) as Record<string, string>
    expect(accepted.status).toBe('running')
    expect(accepted.stream_url).toContain('/stream?token=')
    expect(accepted.cancel_url).toContain('/cancel?token=')

    const stream = await engine.app.request(new URL(accepted.stream_url!).pathname + new URL(accepted.stream_url!).search)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    expect(stream.headers.get('cache-control')).toBe('no-store')
    const sse = parseSse(await readSseUntil(stream, (b) => b.includes('event: done')))
    // subscribed after start — per SPEC §6.6 a snapshot comes first
    expect(sse[0]!.event).toBe('snapshot')
    expect(sse.find((e) => e.event === 'delta')!.data.text).toBe('Done.')
    expect(sse.some((e) => e.event === 'step')).toBe(true)
    expect(sse.find((e) => e.event === 'done')!.data.status).toBe('completed')

    await waitFor(() => callbacks.requests.length > 0)
    const cb = callbacks.requests[0]!
    expect(cb.headers.authorization).toBe('Bearer harness')
    const payload = (cb.body as { payload: RunResult }).payload
    expect(payload.contract_version).toBe('1')
    expect(payload.run_id).toBe(accepted.run_id)
    expect(payload.status).toBe('completed')
  })

  it('wait: true returns the result synchronously', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('in sync'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, runRequest())
    expect(res.status).toBe(200)
    const body = (await res.json()) as RunResult
    expect(body.status).toBe('completed')
    expect(body.messages).toHaveLength(1)
  })

  it('seq is monotonic within a run, history_revision is echoed in the callback and GET', async () => {
    const callbacks = await okCallbacks()
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: {} })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 't', {}), toolCall('c2', 't', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('all done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({
        history_revision: 12,
        tools: [{ name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read' }] as never,
      }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id } = (await res.json()) as { run_id: string }

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.history_revision).toBe(12)
    expect(payload.messages.map((m) => (m as { seq: number }).seq)).toEqual([0, 1, 2, 3])

    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    expect(((await get.json()) as RunResult).history_revision).toBe(12)
  })
})

describe('idempotency and validation (SPEC §4.2, §11.2)', () => {
  it('a repeat with the same key → 200 with the same run_id, no second run', async () => {
    let calls = 0
    const model = mockModel(async () => {
      calls++
      return streamFrom([START, ...textChunks('once'), finish('stop')])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const body = runRequest({ idempotency_key: 'msg_1' })
    const first = await post(engine, body)
    const firstBody = (await first.json()) as RunResult
    const second = await post(engine, body)
    expect(second.status).toBe(200)
    expect(((await second.json()) as { run_id: string }).run_id).toBe(firstBody.run_id)
    expect(calls).toBe(1)
  })

  it('same key, different body → 409 idempotency_mismatch', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('once'), finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    await post(engine, runRequest({ idempotency_key: 'msg_1' }))
    const res = await post(engine, runRequest({ idempotency_key: 'msg_1', system: 'A different prompt.' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('idempotency_mismatch')
  })

  it('a write tool without context → 400 write_context_missing listing the fields', async () => {
    const model = mockModel(async () => streamFrom([START, finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        tools: [
          { name: 'place_order', input_schema: { type: 'object' }, endpoint: 'https://tools.example.com/x', effect: 'write' },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('write_context_missing')
    expect(body.error.missing.sort()).toEqual(['history_revision', 'idempotency_key', 'meta.session_id'])
  })

  it('a read-only tool without idempotency_key / session_id passes', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        tools: [
          { name: 'read', input_schema: { type: 'object' }, endpoint: 'https://tools.example.com/x', effect: 'read' },
        ] as never,
      }),
    )
    expect(res.status).toBe(200)
  })

  it('a history with an unresolved tool_call → 400 unresolved_tool_call', async () => {
    const model = mockModel(async () => streamFrom([START, finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [{ type: 'tool_call', call_id: 'c1', tool: 't', args: {} }] },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('unresolved_tool_call')
  })

  it('a history ending with an assistant reply → 400 history_ends_with_assistant, the model is not called', async () => {
    let calls = 0
    const model = mockModel(async () => {
      calls += 1
      return streamFrom([START, finish('stop')])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }] },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('history_ends_with_assistant')
    expect(calls).toBe(0)
  })

  it('a body larger than MAX_REQUEST_BYTES → 413', async () => {
    const model = mockModel(async () => streamFrom([START, finish('stop')]))
    const engine = track(
      createEngine(testConfig({ MAX_REQUEST_BYTES: '2048' }), { modelFactory: mockFactory(model) }),
    )

    const res = await post(
      engine,
      runRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] as never }),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as any).error.code).toBe('payload_too_large')
  })

  it('a tool on a disallowed host → 400 egress_denied', async () => {
    const model = mockModel(async () => streamFrom([START, finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        tools: [
          { name: 't', input_schema: { type: 'object' }, endpoint: 'https://evil.example.org/x', effect: 'read' },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('egress_denied')
  })

  it('no Bearer → 401, a wrong token → 401', async () => {
    const model = mockModel(async () => streamFrom([START, finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const noAuth = await engine.app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runRequest()),
    })
    expect(noAuth.status).toBe(401)

    const wrong = await engine.app.request('/runs', {
      method: 'POST',
      headers: { ...bearer('wrong-token'), 'Content-Type': 'application/json' },
      body: JSON.stringify(runRequest()),
    })
    expect(wrong.status).toBe(401)
  })

  it('an unknown provider → 400 provider_not_allowed, no key → provider_key_missing', async () => {
    const engine = track(createEngine(testConfig()))

    const notAllowed = await post(engine, runRequest({ llm: { provider: 'ollama', model: 'llama' } as never }))
    expect(notAllowed.status).toBe(400)
    expect(((await notAllowed.json()) as any).error.code).toBe('provider_not_allowed')

    const noKey = await post(engine, runRequest({ llm: { provider: 'anthropic', model: 'claude-sonnet-5' } as never }))
    expect(noKey.status).toBe(400)
    expect(((await noKey.json()) as any).error.code).toBe('provider_key_missing')
  })
})

describe('images (SPEC §5.3)', () => {
  it('a data: URL reaches the model as bytes', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('I can see it'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is in the picture?' },
              { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
            ],
          },
        ] as never,
      }),
    )
    expect(res.status).toBe(200)
    const prompt = model.doStreamCalls[0]!.prompt
    const userMessage = prompt.find((m) => m.role === 'user')!
    const filePart = (userMessage.content as Array<Record<string, any>>).find((p) => p.type === 'file')
    expect(filePart).toBeTruthy()
    expect(filePart!.mediaType).toBe('image/png')
  })

  it('the engine fetches an https image with its own egress client', async () => {
    const images = trackServer(
      await startServer((_b, _r, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(Buffer.from('hello'))
      }),
    )
    const model = mockModel([streamFrom([START, ...textChunks('I can see it'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'image', url: `${images.url}/pic.png` }] },
        ] as never,
      }),
    )
    expect(res.status).toBe(200)
    expect(images.requests).toHaveLength(1)
  })

  it('data: with an unsupported MIME type → 400 unsupported_media_type', async () => {
    const engine = track(createEngine(testConfig()))
    const res = await post(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'image', url: 'data:application/pdf;base64,aGVsbG8=' }] },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('unsupported_media_type')
  })

  it('an image from a disallowed host → 400 egress_denied', async () => {
    const engine = track(createEngine(testConfig()))
    const res = await post(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'image', url: 'https://evil.example.org/pic.png' }] },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('egress_denied')
  })
})

describe('SSE: snapshot, replay, gap, expose_* (SPEC §6.6)', () => {
  it('connecting without Last-Event-ID gives a snapshot and then only new events', async () => {
    const callbacks = await okCallbacks()
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream([START, ...textChunks('first part')], abortSignal),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const first = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    await readSseUntil(first, (b) => b.includes('first part'))

    const second = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    const secondText = await readSseUntil(second, (b) => b.includes('event: snapshot'))
    const events = parseSse(secondText)
    const snapshot = events.find((e) => e.event === 'snapshot')!
    expect(snapshot.data.text).toBe('first part')
    expect(typeof snapshot.data.through_event_id).toBe('number')
    // the text is not duplicated by delta events up to the watermark
    expect(events.filter((e) => e.event === 'delta')).toHaveLength(0)

    await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
  })

  it('Last-Event-ID within the buffer window → an exact replay of the tail without a snapshot', async () => {
    const callbacks = await okCallbacks()
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream(
        [START, ...textChunks('alpha', 'a'), ...textChunks('beta', 'b')],
        abortSignal,
      ),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const first = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    const firstEvents = parseSse(await readSseUntil(first, (b) => b.includes('beta')))
    const alpha = firstEvents.find((e) => e.event === 'delta' && e.data.text === 'alpha')!

    const replay = await engine.app.request(`/runs/${run_id}/stream?token=${token}`, {
      headers: { 'Last-Event-ID': String(alpha.id) },
    })
    const replayEvents = parseSse(await readSseUntil(replay, (b) => b.includes('beta')))
    expect(replayEvents.some((e) => e.event === 'snapshot')).toBe(false)
    expect(replayEvents.map((e) => e.data?.text)).toContain('beta')
    expect(replayEvents.map((e) => e.data?.text)).not.toContain('alpha')

    await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
  })

  it('buffer eviction → a gap before the snapshot', async () => {
    const callbacks = await okCallbacks()
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream(
        [START, ...Array.from({ length: 40 }, (_, i) => ({ type: 'text-delta' as const, id: 't', delta: `part-${i} ${'x'.repeat(400)}` }))],
        abortSignal,
      ),
    )
    const engine = track(
      createEngine(testConfig({ SSE_BUFFER_MAX_BYTES: '1024' }), { modelFactory: mockFactory(model) }),
    )

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const first = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    await readSseUntil(first, (b) => b.includes('part-39'))

    const late = await engine.app.request(`/runs/${run_id}/stream?token=${token}`, {
      headers: { 'Last-Event-ID': '2' },
    })
    const events = parseSse(await readSseUntil(late, (b) => b.includes('event: snapshot')))
    expect(events[0]!.event).toBe('gap')
    expect(events[1]!.event).toBe('snapshot')
    expect(events[1]!.data.text).toContain('part-39')

    await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
  })

  it('expose_args / expose_result reveal args and result, absent by default', async () => {
    const tools = trackServer(
      await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { secret: 'tenant-data' } })),
    )
    const toolDef = { name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read' }
    const makeEngine = () =>
      createEngine(
        testConfig(),
        {
          modelFactory: mockFactory(
            mockModel([
              streamFrom([START, toolCall('c1', 't', { query: 'confidential' }), finish('tool-calls')]),
              streamFrom([START, ...textChunks('done'), finish('stop')]),
            ]),
          ),
        },
      )

    const callbacks = await okCallbacks()

    const quiet = track(makeEngine())
    const quietRes = await post(quiet, {
      ...runRequest({ tools: [toolDef] as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const quietRun = (await quietRes.json()) as { run_id: string; cancel_url: string }
    const quietToken = new URL(quietRun.cancel_url).searchParams.get('token')!
    const quietSse = parseSse(
      await readSseUntil(
        await quiet.app.request(`/runs/${quietRun.run_id}/stream?token=${quietToken}`),
        (b) => b.includes('event: done'),
      ),
    )
    expect(quietSse.find((e) => e.event === 'tool_call')!.data.args).toBeUndefined()
    expect(quietSse.find((e) => e.event === 'tool_result')!.data.result).toBeUndefined()

    const loud = track(makeEngine())
    const loudRes = await post(loud, {
      ...runRequest({ tools: [toolDef] as never, stream: { expose_args: true, expose_result: true } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const loudRun = (await loudRes.json()) as { run_id: string; cancel_url: string }
    const loudToken = new URL(loudRun.cancel_url).searchParams.get('token')!
    const loudSse = parseSse(
      await readSseUntil(
        await loud.app.request(`/runs/${loudRun.run_id}/stream?token=${loudToken}`),
        (b) => b.includes('event: done'),
      ),
    )
    expect(loudSse.find((e) => e.event === 'tool_call')!.data.args).toEqual({ query: 'confidential' })
    expect(loudSse.find((e) => e.event === 'tool_result')!.data.result).toEqual({ secret: 'tenant-data' })
  })

  it('a stream without a token → 401, after the run is deleted → 404', async () => {
    const registry = new RunRegistry(testConfig())
    const model = mockModel([streamFrom([START, ...textChunks('all done'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model), registry }))

    const res = await post(engine, runRequest())
    const { run_id } = (await res.json()) as RunResult

    const noToken = await engine.app.request(`/runs/${run_id}/stream`)
    expect(noToken.status).toBe(401)

    registry.delete(run_id, 'test')
    const gone = await engine.app.request(`/runs/${run_id}/stream?token=whatever`)
    expect(gone.status).toBe(404)
  })
})

describe('cancel with a hanging tool (SPEC §4.4)', () => {
  it('not finished within 5 s → 202 cancelling, a repeated cancel is also 202', async () => {
    const callbacks = await okCallbacks()
    const tools = trackServer(
      await startServer(() => {
        /* never respond — the connection hangs */
      }),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 't', {}), finish('tool-calls')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({
        tools: [
          { name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read', timeout_ms: 30_000 },
        ] as never,
      }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    await waitFor(() => tools.requests.length > 0)

    const registry = engine.deps.registry
    const run = registry.get(run_id)!
    // simulate a tool that holds the connection: abort already sent, no terminal status yet
    run.status = 'cancelling'
    run.abortReason = 'user'

    const cancelled = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, {
      method: 'POST',
    })
    expect(cancelled.status).toBe(202)
    expect(await cancelled.json()).toEqual({ run_id, status: 'cancelling' })

    const again = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    expect(again.status).toBe(202)

    // GET on a cancelling run returns the running shape (SPEC §4.4)
    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    expect(((await get.json()) as any).status).toBe('running')

    run.abort.abort(new Error('cleanup'))
  }, 30_000)
})

describe('graceful shutdown (SPEC §11.1)', () => {
  it('an in-flight run gets cancelled / shutdown and the callback is sent', async () => {
    const callbacks = await okCallbacks()
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream([START, ...textChunks('unfinished')], abortSignal),
    )
    const engine = createEngine(testConfig({ SHUTDOWN_GRACE_MS: '100' }), {
      modelFactory: mockFactory(model),
    })

    await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    await waitFor(() => engine.deps.registry.activeCount === 1)

    await engine.shutdown()

    expect(engine.shuttingDown()).toBe(true)
    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.status).toBe('cancelled')
    expect(payload.finish_reason).toBe('shutdown')
    expect((payload.messages[0] as Record<string, any>).partial).toBe(true)

    const rejected = await post(engine, runRequest())
    expect(rejected.status).toBe(503)
    expect(((await rejected.json()) as any).error.code).toBe('shutting_down')
  })

  it('health reports state without auth', async () => {
    const engine = track(createEngine(testConfig(), {}, '1.2.3'))
    const res = await engine.app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, version: '1.2.3', shutting_down: false })
  })
})
