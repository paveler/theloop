/**
 * Regressions from the October 2026 audit: engine-side findings.
 * Each test covers one hole that was found.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { EgressClient } from '../src/egress/client.js'
import { assertToolInvariant } from '../src/runs/messages.js'
import { logBuffer } from '../src/log.js'
import { bearer, finish, json, mockFactory, mockModel, runRequest, START, startServer, streamFrom, textChunks, testConfig, toolCall, waitFor } from './helpers.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks() })
function track(engine: Engine) { cleanup.push(async () => { await engine.shutdown(); await engine.deps.egress.close() }); return engine }
const read = async (res: Response | Promise<Response>) => (await (await res).json()) as RunResult
const post = (engine: Engine, body: unknown) => engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
const def = (url: string, name = 'read', effect: 'read' | 'write' = 'read') => ({ name, endpoint: url + '/' + name, effect, input_schema: { type: 'object' } })

it('a repeated call does not consume the remaining HTTP tool budget', async () => {
  const server = await startServer((_b, _q, res) => json(res, 200, { status: 'ok', result: 'found' }))
  cleanup.push(server.close)
  const model = mockModel([
    streamFrom([START, toolCall('a', 'read', {}), finish('tool-calls')]),
    streamFrom([START, toolCall('b', 'read', {}), finish('tool-calls')]),
    streamFrom([START, ...textChunks('Answer'), finish('stop')]),
  ])
  const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
  const result = await read(post(engine, runRequest({ tools: [def(server.url)], limits: { max_tool_calls: 1 } } as never)))
  expect(result.status).toBe('completed')
})

it('cancellation seals a deferred call in a mixed batch', async () => {
  const server = await startServer((_b, req, res) => {
    if (req.url === '/write') json(res, 200, { status: 'deferred', operation_id: 'op_1' })
    if (req.url === '/callback') json(res, 200, {})
  })
  cleanup.push(server.close)
  const model = mockModel([streamFrom([START, toolCall('w', 'write', {}), toolCall('r', 'read', {}), finish('tool-calls')])])
  const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
  const accepted = await read(post(engine, runRequest({ wait: false, callback: { url: server.url + '/callback' }, tools: [def(server.url), def(server.url, 'write', 'write')], idempotency_key: 'origin', history_revision: 1, meta: { session_id: 's' } } as never)))
  await waitFor(() => engine.deps.registry.get(accepted.run_id)?.calls.get('w')?.state === 'closed')
  const cancelled = await engine.app.request(`/runs/${accepted.run_id}/cancel`, { method: 'POST', headers: bearer() })
  const result = await read(cancelled)
  expect(result.status).toBe('cancelled')
  expect(() => assertToolInvariant(result.messages)).not.toThrow()
  // the harness needs the operation to cancel it (SPEC Appendix A)
  const write = result.tool_calls.find((c) => c.call_id === 'w')
  expect(write).toMatchObject({ status: 'cancelled', operation_id: 'op_1' })
})

it('cancellation during a remote image download remains cancelled', async () => {
  const server = await startServer((_b, req, res) => { if (req.url === '/callback') json(res, 200, {}) })
  cleanup.push(server.close)
  const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(mockModel([])) }))
  const accepted = await read(post(engine, runRequest({ wait: false, callback: { url: server.url + '/callback' }, messages: [{ role: 'user', content: [{ type: 'image', url: server.url + '/image' }] }] } as never)))
  await waitFor(() => server.requests.some((r) => r.path === '/image'))
  const result = await read(engine.app.request(`/runs/${accepted.run_id}/cancel`, { method: 'POST', headers: bearer() }))
  expect(result.status).toBe('cancelled')
})

it('output estimates include generated tool arguments without provider usage', async () => {
  const end = finish('tool-calls')
  if (end.type !== 'finish') throw new Error('unexpected')
  end.usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
  const model = mockModel([streamFrom([START, toolCall('c', 'read', { text: 'a'.repeat(8000) }), end])])
  const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model, { capabilities: { parallel_tools: false, usage_in_stream: false } }) }))
  const result = await read(post(engine, runRequest({ tools: [def('https://tools.example.com')], limits: { max_steps: 1 } } as never)))
  expect(result.usage.calls[0]?.estimated).toBe(true)
  expect(result.usage.calls[0]?.output_tokens).toBeGreaterThan(2000)
})

it('callback diagnostics do not expose the configured callback secret', async () => {
  const secret = 'synthetic-callback-secret-123456'
  const egress = new EgressClient(testConfig())
  vi.spyOn(egress, 'request').mockImplementation(async () => ({ status: 400, text: JSON.stringify({ 'x-engine-secret': secret }), headers: {}, bytes: new Uint8Array() }))
  const engine = track(createEngine(testConfig({ CALLBACK_SECRET: secret }), { egress, modelFactory: mockFactory(mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])) }))
  const result = await read(post(engine, runRequest({ callback: { url: 'https://tools.example.com/callback' } })))
  await waitFor(() => engine.deps.registry.get(result.run_id)?.delivery.lastError != null)
  expect.soft(engine.deps.registry.get(result.run_id)?.delivery.lastError).not.toContain(secret)
  expect.soft(JSON.stringify(logBuffer().query({ runId: result.run_id, limit: 100 }))).not.toContain(secret)
})

it('the prompt budget includes date lines on all historical user messages', async () => {
  const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
  const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
  const messages = Array.from({ length: 20 }, () => ({ role: 'user', content: [{ type: 'text', text: 'x' }], created_at: '2026-10-01T12:00:00Z' }))
  const result = await read(post(engine, runRequest({ messages, limits: { max_tokens: 1, max_total_tokens: 300 } } as never)))
  expect(result.status).toBe('stopped_limit')
  expect(model.doStreamCalls).toHaveLength(0)
})
