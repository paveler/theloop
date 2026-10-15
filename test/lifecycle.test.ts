/**
 * Session lock until ack, retention, eviction and memory hygiene
 * (SPEC §3.1, §4.8, §11.2, §11.5).
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
  runRequest,
  START,
  startServer,
  streamFrom,
  textChunks,
  testConfig,
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

const quick = () => mockModel(async () => streamFrom([START, ...textChunks('answer'), finish('stop')]))

describe('session lock until ack (SPEC §3.1)', () => {
  it('running → session_busy; cancel → result_pending; GET → ack → a new run passes', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 500, { fail: true })))
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(
      createEngine(testConfig({ CALLBACK_ATTEMPT_TIMEOUT_MS: '300' }), { modelFactory: mockFactory(model) }),
    )

    const first = await post(engine, {
      ...runRequest({ meta: { session_id: 'sess_A' } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    expect(first.status).toBe(202)
    const { run_id, cancel_url } = (await first.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    const busy = await post(engine, {
      ...runRequest({ meta: { session_id: 'sess_A' } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    expect(busy.status).toBe(409)
    const busyBody = (await busy.json()) as any
    expect(busyBody.error.code).toBe('session_busy')
    expect(busyBody.error.active_run_id).toBe(run_id)
    expect(busyBody.error.retriable).toBe(true)

    const cancelled = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    expect(cancelled.status).toBe(200)

    // terminal but not acked — the lock still holds
    const pending = await post(engine, {
      ...runRequest({ meta: { session_id: 'sess_A' } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    expect(pending.status).toBe(409)
    const pendingBody = (await pending.json()) as any
    expect(pendingBody.error.code).toBe('result_pending')
    expect(pendingBody.error.pending_run_id).toBe(run_id)

    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    expect(get.status).toBe(200)
    expect(((await get.json()) as any).acked).toBe(false)

    const ack = await engine.app.request(`/runs/${run_id}/ack`, { method: 'POST', headers: bearer() })
    expect(ack.status).toBe(200)
    expect(await ack.json()).toEqual({ acked: true })

    const engineNext = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()), registry: engine.deps.registry }))
    const next = await post(engineNext, runRequest({ meta: { session_id: 'sess_A' } as never }))
    expect(next.status).toBe(200)
  })

  it('2xx on the callback = auto-ack: the lock is released by itself', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const res = await post(engine, {
      ...runRequest({ meta: { session_id: 'sess_B' } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id } = (await res.json()) as { run_id: string }

    await waitFor(() => engine.deps.registry.get(run_id)?.acked === true)
    expect(engine.deps.registry.sessionLockHolder('sess_B')).toBeUndefined()
  })

  it('wait: true without session_id — auto-ack; with session_id — lock until an explicit ack', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const noSession = await post(engine, runRequest())
    const noSessionBody = (await noSession.json()) as RunResult
    expect(engine.deps.registry.get(noSessionBody.run_id)!.acked).toBe(true)

    const engine2 = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))
    const withSession = await post(engine2, runRequest({ meta: { session_id: 'sess_C' } as never }))
    const withSessionBody = (await withSession.json()) as RunResult
    expect(engine2.deps.registry.get(withSessionBody.run_id)!.acked).toBe(false)

    const blocked = await post(engine2, runRequest({ meta: { session_id: 'sess_C' } as never }))
    expect(blocked.status).toBe(409)
    expect(((await blocked.json()) as any).error.code).toBe('result_pending')

    await engine2.app.request(`/runs/${withSessionBody.run_id}/ack`, { method: 'POST', headers: bearer() })
    const passes = await post(
      track(createEngine(testConfig(), { modelFactory: mockFactory(quick()), registry: engine2.deps.registry })),
      runRequest({ meta: { session_id: 'sess_C' } as never }),
    )
    expect(passes.status).toBe(200)
  })

  it('a repeated POST with the same idempotency_key gives 200, not 409 result_pending', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))
    const body = runRequest({ idempotency_key: 'msg_42', meta: { session_id: 'sess_D' } as never })

    const first = await post(engine, body)
    expect(first.status).toBe(200)
    const second = await post(engine, body)
    expect(second.status).toBe(200)
    expect(((await second.json()) as any).run_id).toBe(((await first.json()) as RunResult).run_id)
  })

  it('ack on an unfinished run → 409 not_finished, ack is idempotent', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('working')], abortSignal))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }

    const early = await engine.app.request(`/runs/${run_id}/ack`, { method: 'POST', headers: bearer() })
    expect(early.status).toBe(409)
    expect(((await early.json()) as any).error.code).toBe('not_finished')

    const token = new URL(cancel_url).searchParams.get('token')!
    await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })

    const first = await engine.app.request(`/runs/${run_id}/ack`, { method: 'POST', headers: bearer() })
    const again = await engine.app.request(`/runs/${run_id}/ack`, { method: 'POST', headers: bearer() })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
  })
})

describe('memory of a terminal run (SPEC §11.5)', () => {
  it('after the terminal state there is no api_key, no tool headers and no original history', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const res = await post(
      engine,
      runRequest({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'secret-user-question' }] }] as never,
      }),
    )
    const { run_id } = (await res.json()) as RunResult
    const record = engine.deps.registry.get(run_id)!

    expect(record.request).toBeNull()
    const retained = JSON.stringify(record.result)
    expect(retained).not.toContain('sk-test')
    expect(retained).not.toContain('secret-user-question')
  })

  it('CALLBACK_SECRET goes as the X-Engine-Secret header and overrides the same header from the request', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(
      createEngine(testConfig({ CALLBACK_SECRET: 'env-secret' }), { modelFactory: mockFactory(quick()) }),
    )

    const res = await post(engine, {
      ...runRequest(),
      wait: false,
      callback: {
        url: `${callbacks.url}/cb`,
        headers: { Authorization: 'Bearer harness-secret', 'x-engine-secret': 'spoofed' },
      },
    })
    const { run_id } = (await res.json()) as { run_id: string }
    await waitFor(() => engine.deps.registry.get(run_id)!.delivery.status === 'delivered')

    const sent = callbacks.requests[0]!.headers
    expect(sent['x-engine-secret']).toBe('env-secret')
    expect(sent['authorization']).toBe('Bearer harness-secret')
    // the secret stays out of both the result and GET
    expect(JSON.stringify(engine.deps.registry.get(run_id)!.result)).not.toContain('env-secret')
  })

  it('the callback body is a single payload field with the whole result', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const res = await post(engine, {
      ...runRequest({ meta: { session_id: 'sess_payload' } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id } = (await res.json()) as { run_id: string }
    await waitFor(() => engine.deps.registry.get(run_id)!.delivery.status === 'delivered')

    const body = callbacks.requests[0]!.body as Record<string, any>
    expect(Object.keys(body)).toEqual(['payload'])
    expect(body.payload).toMatchObject({ contract_version: '1', run_id, status: 'completed', finish_reason: 'end_turn' })
    expect(body.payload.meta.session_id).toBe('sess_payload')
    expect(Array.isArray(body.payload.messages)).toBe(true)
    // GET and wait return the result as is, without the wrapper
    expect((engine.deps.registry.get(run_id)!.result as any).payload).toBeUndefined()
  })

  it('without CALLBACK_SECRET the X-Engine-Secret header is not added', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id } = (await res.json()) as { run_id: string }
    await waitFor(() => engine.deps.registry.get(run_id)!.delivery.status === 'delivered')

    expect(callbacks.requests[0]!.headers['x-engine-secret']).toBeUndefined()
  })

  it('callback.headers live until delivery and are removed after it', async () => {
    const callbacks = trackServer(
      await startServer((_b, _r, res) => {
        setTimeout(() => json(res, 200, { ok: true }), 250)
      }),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(quick()) }))

    const res = await post(engine, {
      ...runRequest(),
      wait: false,
      callback: { url: `${callbacks.url}/cb`, headers: { Authorization: 'Bearer harness-secret' } },
    })
    const { run_id } = (await res.json()) as { run_id: string }
    const record = engine.deps.registry.get(run_id)!

    await waitFor(() => record.result != null)
    expect(record.delivery.headers?.Authorization).toBe('Bearer harness-secret')

    await waitFor(() => record.delivery.status === 'delivered')
    expect(record.delivery.headers).toBeNull()
    expect(record.delivery.url).toBeNull()
  })

  it('GET shows the status of an undelivered callback', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 500, { fail: true })))
    const engine = track(
      createEngine(testConfig({ CALLBACK_ATTEMPT_TIMEOUT_MS: '300' }), { modelFactory: mockFactory(quick()) }),
    )

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id } = (await res.json()) as { run_id: string }

    await waitFor(() => engine.deps.registry.get(run_id)?.delivery.lastError != null)
    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    const body = (await get.json()) as any
    expect(body.callback.status).toBe('pending')
    expect(body.callback.attempts).toBeGreaterThanOrEqual(1)
    // the receiver's response body goes into last_error: without it the refusal cannot be diagnosed
    expect(body.callback.last_error).toBe('HTTP 500: {"fail":true}')
    expect(body.acked).toBe(false)
  })
})

describe('retention and eviction (SPEC §11.5)', () => {
  it('once retention expires the run is removed, GET → 404', async () => {
    const registry = new RunRegistry(testConfig({ RUN_RETENTION_MS: '1' }))
    const engine = track(
      createEngine(testConfig({ RUN_RETENTION_MS: '1' }), { modelFactory: mockFactory(quick()), registry }),
    )

    const res = await post(engine, runRequest())
    const { run_id } = (await res.json()) as RunResult

    await new Promise((r) => setTimeout(r, 20))
    registry.sweep()

    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    expect(get.status).toBe(404)
    expect(((await get.json()) as any).error.code).toBe('run_not_found')
  })

  it('the oldest acked runs are evicted when MAX_RETAINED_RUNS overflows', async () => {
    const config = testConfig({ MAX_RETAINED_RUNS: '2' })
    const registry = new RunRegistry(config)
    const engine = track(
      createEngine(config, { modelFactory: mockFactory(mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))), registry }),
    )

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const engineI = createEngine(config, {
        modelFactory: mockFactory(mockModel(async () => streamFrom([START, ...textChunks(`answer ${i}`), finish('stop')]))),
        registry,
      })
      const res = await post(engineI, runRequest())
      ids.push(((await res.json()) as RunResult).run_id)
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(registry.get(ids[0]!)).toBeUndefined()
    expect(registry.get(ids[2]!)).toBeDefined()
    void engine
  })

  it('unacked runs are not evicted: with the ceiling full a new POST gets 429 overloaded', async () => {
    const config = testConfig({ MAX_RETAINED_RUNS: '1' })
    const registry = new RunRegistry(config)
    const engine = track(createEngine(config, { modelFactory: mockFactory(quick()), registry }))

    const first = await post(engine, runRequest({ meta: { session_id: 'sess_X' } as never }))
    expect(first.status).toBe(200)
    const firstId = ((await first.json()) as RunResult).run_id

    const engine2 = createEngine(config, { modelFactory: mockFactory(quick()), registry })
    const second = await post(engine2, runRequest({ meta: { session_id: 'sess_Y' } as never }))
    expect(second.status).toBe(429)
    expect(((await second.json()) as any).error.code).toBe('overloaded')
    expect(registry.get(firstId)).toBeDefined()

    // acked — the slot is freed
    await engine.app.request(`/runs/${firstId}/ack`, { method: 'POST', headers: bearer() })
    const third = await post(
      createEngine(config, { modelFactory: mockFactory(quick()), registry }),
      runRequest({ meta: { session_id: 'sess_Z' } as never }),
    )
    expect(third.status).toBe(200)
    expect(registry.get(firstId)).toBeUndefined()
  })

  it('MAX_RETAINED_BYTES evicts acked runs too', async () => {
    const config = testConfig({ MAX_RETAINED_BYTES: '64' })
    const registry = new RunRegistry(config)
    const engine = track(createEngine(config, { modelFactory: mockFactory(quick()), registry }))

    const first = await post(engine, runRequest())
    const firstId = ((await first.json()) as RunResult).run_id
    expect(registry.get(firstId)).toBeDefined()

    const second = await post(
      createEngine(config, { modelFactory: mockFactory(quick()), registry }),
      runRequest(),
    )
    expect(second.status).toBe(200)
    expect(registry.get(firstId)).toBeUndefined()
  })

  it('MAX_CONCURRENT_RUNS: over the limit — 429 overloaded', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const config = testConfig({ MAX_CONCURRENT_RUNS: '1' })
    const registry = new RunRegistry(config)
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('hanging')], abortSignal))
    const engine = track(createEngine(config, { modelFactory: mockFactory(model), registry }))

    const first = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    expect(first.status).toBe(202)

    const second = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    expect(second.status).toBe(429)
    expect(((await second.json()) as any).error.code).toBe('overloaded')
  })
})
