/**
 * Fixes from the first public review: egress refusals are not retried, a call closed on a
 * terminal run is cancelled, the SSE buffer counts bytes, auth comes before the run lookup,
 * token comparison does not depend on length.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { timingSafeEqualStr } from '../src/ids.js'
import { SseHub } from '../src/stream/sse.js'
import {
  bearer,
  finish,
  json,
  mockFactory,
  mockModel,
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

describe('egress: a private address is refused once', () => {
  it('an allowlisted host that resolves to a private address is not retried', async () => {
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getOrder', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('The order service is unavailable.'), finish('stop')]),
    ])
    // https and an allowlisted host pass validation; DNS gives 127.0.0.1 / ::1 at connect time
    const config = testConfig({ ALLOW_INSECURE_EGRESS: '0', EGRESS_ALLOWLIST: 'localhost' })
    const engine = track(createEngine(config, { modelFactory: mockFactory(model) }))

    const started = Date.now()
    const res = await post(engine, {
      ...runRequest({
        tools: [
          {
            name: 'getOrder',
            input_schema: { type: 'object', properties: { id: { type: 'string' } } },
            endpoint: 'https://localhost:4431/tools/getOrder',
            effect: 'read',
          },
        ] as never,
      }),
      wait: true,
    })
    const result = (await res.json()) as RunResult

    expect(result.status).toBe('completed')
    const toolMessage = result.messages.find((m) => m.role === 'tool') as Record<string, any>
    expect(toolMessage.error).toBe('egress_denied: private address')
    expect(result.tool_calls[0]!.status).toBe('http_error')
    // no 1 s + 3 s retry pauses
    expect(Date.now() - started).toBeLessThan(900)

    const logs = await engine.app.request(`/runs/${result.run_id}/logs?event=tool_http`, { headers: bearer() })
    const { entries } = (await logs.json()) as { entries: unknown[] }
    expect(entries).toHaveLength(1)
  })
})

describe('tools: a call closed while waiting', () => {
  it('is cancelled, not timed out (SPEC §6.5)', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'accepted' })))
    const callbacks = trackServer(await startServer((_body, _req, res) => json(res, 200, {})))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'slowReport', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('The report was not built.'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({
        tools: [
          { name: 'slowReport', input_schema: { type: 'object' }, endpoint: `${tools.url}/r`, effect: 'read', timeout_ms: 10_000 },
        ] as never,
      }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const runId = ((await res.json()) as { run_id: string }).run_id
    const run = engine.deps.registry.get(runId)!
    await waitFor(() => [...run.calls.values()].some((call) => call.waiter != null))

    engine.deps.registry.closeCall([...run.calls.values()][0]!)
    await waitFor(() => run.result != null)

    const toolMessage = run.result!.messages.find((m) => m.role === 'tool') as Record<string, any>
    expect(toolMessage.error).toBe('cancelled')
    expect(run.result!.tool_calls[0]!.status).not.toBe('timeout')
  })
})

describe('SSE: the buffer ceiling is in bytes', () => {
  it('multibyte text counts by its UTF-8 size', () => {
    const data = { text: 'é'.repeat(30) }
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8') + 32

    const hub = new SseHub(200)
    hub.emit('delta', data)
    expect(hub.bytes).toBe(size)

    // two such events exceed 200 bytes, though their UTF-16 length would not
    hub.emit('delta', data)
    expect(hub.bytes).toBe(size)
  })
})

describe('auth before the run lookup', () => {
  it('no credential → 401 whether or not the run exists; a token → the run is looked up', async () => {
    const engine = track(createEngine(testConfig()))

    const stream = await engine.app.request('/runs/run_missing/stream')
    expect(stream.status).toBe(401)
    const cancel = await engine.app.request('/runs/run_missing/cancel', { method: 'POST' })
    expect(cancel.status).toBe(401)
    const toolResult = await engine.app.request('/runs/run_missing/tool-result', {
      method: 'POST',
      body: JSON.stringify({ call_id: 'c1', result: {} }),
    })
    expect(toolResult.status).toBe(401)

    const withToken = await engine.app.request('/runs/run_missing/stream?token=anything')
    expect(withToken.status).toBe(404)
    const withBearer = await engine.app.request('/runs/run_missing/cancel', { method: 'POST', headers: bearer() })
    expect(withBearer.status).toBe(404)
  })
})

describe('token comparison', () => {
  it('equal, different, different length', () => {
    expect(timingSafeEqualStr('secret-token', 'secret-token')).toBe(true)
    expect(timingSafeEqualStr('secret-token', 'secret-tokeN')).toBe(false)
    expect(timingSafeEqualStr('secret-token', 'secret')).toBe(false)
    expect(timingSafeEqualStr('', '')).toBe(true)
  })
})
