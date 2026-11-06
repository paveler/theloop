/** `llm` as an ordered fallback chain (SPEC §9.5). */
import { afterEach, describe, expect, it } from 'vitest'
import { APICallError } from 'ai'
import type { MockLanguageModelV3 } from 'ai/test'
import { configureAlerts } from '../src/alerts.js'
import { createEngine, type Engine } from '../src/app.js'
import type { Llm, RunResult } from '../src/contracts.js'
import type { ModelFactory, ResolvedModel } from '../src/providers/factory.js'
import {
  bearer,
  finish,
  json,
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
  configureAlerts(null)
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

/** A factory that picks the mock by `llm.model`; the rest of the resolved model is per-entry overridable. */
function chainFactory(
  models: Record<string, MockLanguageModelV3>,
  overrides: Record<string, Partial<ResolvedModel>> = {},
): ModelFactory {
  return (llm: Llm) => {
    const model = models[llm.model]
    if (!model) throw new Error(`no mock for ${llm.model}`)
    return {
      providerId: llm.provider,
      model: model as never,
      capabilities: { parallel_tools: true, usage_in_stream: true },
      contextWindow: 200_000,
      maxTokensCap: 32_000,
      supportsCacheControl: false,
      honorsToolChoiceNone: true,
      acceptsSampling: true,
      toolReferences: false,
      providerOptions: {},
      throttleKey: { provider: llm.provider, hash: `hash-${llm.model}` },
      ...overrides[llm.model],
    }
  }
}

function apiError(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: 'https://api.example.com/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseBody: `{"error":"${message}"}`,
  })
}

const failing = (statusCode: number, message: string) =>
  streamFrom([START, { type: 'error', error: apiError(statusCode, message) }])

const answer = (text: string) => streamFrom([START, ...textChunks(text), finish('stop')])

const A = { provider: 'anthropic', model: 'model-a', api_key: 'sk-a' }
const B = { provider: 'openai', model: 'model-b', api_key: 'sk-b' }
const C = { provider: 'deepseek', model: 'model-c', api_key: 'sk-c' }

async function post(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  return engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
}

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await post(engine, { ...body, wait: true })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

function counting(streams: Array<ReturnType<typeof streamFrom>>) {
  const calls: unknown[] = []
  const queue = [...streams]
  const model = mockModel(async (options) => {
    calls.push(options)
    const next = queue.shift()
    if (!next) throw new Error('no prepared stream')
    return next
  })
  return { model, calls }
}

describe('llm chain: contract', () => {
  it('a single llm object: the result has neither llm_used nor llm_fallbacks', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([answer('hi')]) }) }))
    const result = await runWait(engine, runRequest({ llm: A as never }))
    expect(result.status).toBe('completed')
    expect(result).not.toHaveProperty('llm_used')
    expect(result).not.toHaveProperty('llm_fallbacks')
  })

  it('an array whose first entry answers: llm_used is entry 0, llm_fallbacks is []', async () => {
    const b = counting([])
    const engine = track(
      createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([answer('hi')]), 'model-b': b.model }) }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never }))
    expect(result.status).toBe('completed')
    expect(result.llm_used).toEqual({ index: 0, provider: 'anthropic', model: 'model-a' })
    expect(result.llm_fallbacks).toEqual([])
    expect(b.calls).toHaveLength(0)
  })

  it('a one-entry array behaves like the object, with llm_used', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([answer('hi')]) }) }))
    const result = await runWait(engine, runRequest({ llm: [A] as never }))
    expect(result.status).toBe('completed')
    expect(result.llm_used).toEqual({ index: 0, provider: 'anthropic', model: 'model-a' })
  })

  it('an empty array and more than five entries are 400 bad_request', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([]) }) }))
    for (const llm of [[], [A, A, A, A, A, A]]) {
      const res = await post(engine, runRequest({ llm: llm as never }))
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('bad_request')
    }
  })

  it('a provider outside the allowlist in any entry is 400 provider_not_allowed', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([]) }) }))
    const res = await post(engine, runRequest({ llm: [A, { provider: 'nope', model: 'x' }] as never }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('provider_not_allowed')
  })

  it('a missing key in a later entry is refused on receipt, not when the primary fails', async () => {
    // the real factory: openai without a key and without an env key
    const engine = track(createEngine(testConfig({ OPENAI_API_KEY: '' })))
    const res = await post(engine, runRequest({ llm: [A, { provider: 'openai', model: 'gpt-x' }] as never }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('provider_key_missing')
  })

  it('pricing in different currencies is 400 bad_request', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([]), 'model-b': mockModel([]) }) }))
    const res = await post(
      engine,
      runRequest({
        llm: [
          { ...A, pricing: { input: 1, output: 1, currency: 'USD' } },
          { ...B, pricing: { input: 1, output: 1, currency: 'EUR' } },
        ] as never,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.message).toContain('currency')
  })
})

describe('llm chain: fallback', () => {
  it('any failure before content moves to the next entry, without retrying the failed one', async () => {
    const a = counting([failing(503, 'overloaded'), answer('never')])
    const engine = track(
      createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': a.model, 'model-b': mockModel([answer('from b')]) }) }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never }))

    expect(result.status).toBe('completed')
    expect(a.calls).toHaveLength(1)
    expect(result.llm_used).toEqual({ index: 1, provider: 'openai', model: 'model-b' })
    expect(result.llm_fallbacks).toEqual([
      {
        index: 0,
        provider: 'anthropic',
        model: 'model-a',
        step: 1,
        error: expect.objectContaining({ code: 'provider_unavailable', retriable: true, provider_status: 503 }),
      },
    ])
    expect(result.usage.calls.map((c) => [c.provider, c.status])).toEqual([
      ['anthropic', expect.stringMatching(/failed|unknown/)],
      ['openai', 'ok'],
    ])
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'from b' }] })
  })

  it('non-retriable errors fall back too: auth, a bad request, a too-long context', async () => {
    for (const [status, message, code] of [
      [401, 'invalid api key', 'provider_auth'],
      [400, 'model does not exist', 'provider_error'],
      [400, 'prompt is too long', 'context_too_large'],
    ] as const) {
      const engine = track(
        createEngine(testConfig(), {
          modelFactory: chainFactory({ 'model-a': mockModel([failing(status, message)]), 'model-b': mockModel([answer('ok')]) }),
        }),
      )
      const result = await runWait(engine, runRequest({ llm: [A, B] as never }))
      expect(result.status).toBe('completed')
      expect(result.llm_fallbacks?.[0]?.error.code).toBe(code)
    }
  })

  it('walks the whole chain in order', async () => {
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({
          'model-a': mockModel([failing(401, 'bad key')]),
          'model-b': mockModel([failing(400, 'unknown model')]),
          'model-c': mockModel([answer('third')]),
        }),
      }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B, C] as never }))
    expect(result.status).toBe('completed')
    expect(result.llm_used?.index).toBe(2)
    expect(result.llm_fallbacks?.map((f) => [f.index, f.error.code])).toEqual([
      [0, 'provider_auth'],
      [1, 'provider_error'],
    ])
  })

  it('every entry fails: failed with the last error, earlier failures in llm_fallbacks', async () => {
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({
          'model-a': mockModel([failing(401, 'bad key a')]),
          'model-b': mockModel([failing(401, 'bad key b')]),
        }),
      }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_auth')
    expect(result.llm_used).toEqual({ index: 1, provider: 'openai', model: 'model-b' })
    expect(result.llm_fallbacks).toHaveLength(1)
    expect(result.llm_fallbacks?.[0]?.index).toBe(0)
  })

  it('the last entry keeps its own retries', async () => {
    const b = counting([failing(503, 'overloaded'), answer('after retry')])
    const engine = track(
      createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': mockModel([failing(503, 'down')]), 'model-b': b.model }) }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never }))
    expect(result.status).toBe('completed')
    expect(b.calls).toHaveLength(2)
    expect(result.llm_fallbacks).toHaveLength(1)
  })

  it('the switch is sticky: later steps stay on the new entry', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { state: 'shipped' } })))
    const a = counting([failing(503, 'down')])
    const b = counting([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      answer('shipped'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': a.model, 'model-b': b.model }) }))
    const result = await runWait(
      engine,
      runRequest({
        llm: [A, B] as never,
        tools: [{ name: 'getStatus', endpoint: `${tools.url}/getStatus`, effect: 'read' }] as never,
      }),
    )
    expect(result.status).toBe('completed')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(2)
    expect(result.llm_fallbacks).toHaveLength(1)
  })

  it('a failure on a later step falls back from there, with that step in llm_fallbacks', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { state: 'shipped' } })))
    const a = counting([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      failing(401, 'key revoked'),
    ])
    const engine = track(
      createEngine(testConfig(), { modelFactory: chainFactory({ 'model-a': a.model, 'model-b': mockModel([answer('shipped')]) }) }),
    )
    const result = await runWait(
      engine,
      runRequest({
        llm: [A, B] as never,
        tools: [{ name: 'getStatus', endpoint: `${tools.url}/getStatus`, effect: 'read' }] as never,
      }),
    )
    expect(result.status).toBe('completed')
    expect(result.llm_fallbacks?.[0]).toMatchObject({ index: 0, step: 2 })
    expect(result.usage.calls.map((c) => c.provider)).toEqual(['anthropic', 'anthropic', 'openai'])
  })

  it('no fallback after the first content event: the stream interruption fails the run', async () => {
    const b = counting([])
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({
          'model-a': mockModel([
            streamFrom([START, ...textChunks('half an ans'), { type: 'error', error: apiError(503, 'dropped') }]),
          ]),
          'model-b': b.model,
        }),
      }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_stream_interrupted')
    expect(result.llm_fallbacks).toEqual([])
    expect(b.calls).toHaveLength(0)
  })

  it('each attempt gets max_tokens clamped to its own model cap', async () => {
    const a = counting([failing(503, 'down')])
    const b = counting([answer('ok')])
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory(
          { 'model-a': a.model, 'model-b': b.model },
          { 'model-a': { maxTokensCap: 32_000 }, 'model-b': { maxTokensCap: 8_000 } },
        ),
      }),
    )
    const result = await runWait(engine, runRequest({ llm: [A, B] as never, limits: { max_tokens: 20_000 } as never }))
    expect(result.status).toBe('completed')
    expect((a.calls[0] as { maxOutputTokens?: number }).maxOutputTokens).toBe(20_000)
    expect((b.calls[0] as { maxOutputTokens?: number }).maxOutputTokens).toBe(8_000)
  })

  it('cost sums each attempt at its own price; max_cost without a price on every entry is ignored', async () => {
    const usage = (input: number, output: number) => ({
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    })
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({
          'model-a': mockModel([failing(401, 'bad key')]),
          'model-b': mockModel([
            streamFrom([START, ...textChunks('ok'), { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(1000, 100) } as never]),
          ]),
        }),
      }),
    )
    const result = await runWait(
      engine,
      runRequest({
        llm: [
          { ...A, pricing: { input: 3, output: 15 } },
          { ...B, pricing: { input: 1, output: 2 } },
        ] as never,
      }),
    )
    expect(result.status).toBe('completed')
    // 1000 · 1 + 100 · 2 per million, at entry B's price
    expect(result.usage.cost?.amount).toBeCloseTo(0.0012, 10)

    const unpriced = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({ 'model-a': mockModel([answer('ok')]), 'model-b': mockModel([]) }),
      }),
    )
    const r2 = await runWait(
      unpriced,
      runRequest({ llm: [{ ...A, pricing: { input: 3, output: 15 } }, B] as never, limits: { max_cost: 0.000001 } as never }),
    )
    expect(r2.status).toBe('completed')
    expect(r2.usage.cost).toBeUndefined()
  })
})

describe('llm chain: signals', () => {
  it('SSE carries llm_fallback with from, to and the error code, without the provider body', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: chainFactory({ 'model-a': mockModel([failing(503, 'down')]), 'model-b': mockModel([answer('ok')]) }),
      }),
    )
    const res = await post(engine, { ...runRequest({ llm: [A, B] as never }), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!
    const stream = await engine.app.request(`/runs/${run_id}/stream?token=${token}`, { headers: { 'Last-Event-ID': '0' } })
    const text = await readSseUntil(stream, (buf) => buf.includes('event: done'))
    const event = parseSse(text).find((e) => e.event === 'llm_fallback')
    expect(event?.data).toEqual({
      step: 1,
      from: { index: 0, provider: 'anthropic', model: 'model-a' },
      to: { index: 1, provider: 'openai', model: 'model-b' },
      error: { code: 'provider_unavailable', message: expect.any(String) },
    })
  })

  it('a run that survived a fallback sends the llm_fallback alert; a failed one adds the chain to run_failed', async () => {
    const hook = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(
      createEngine(testConfig({ ERROR_WEBHOOK_URL: `${hook.url}/alerts` }), {
        modelFactory: chainFactory({
          'model-a': mockModel([failing(401, 'bad key'), failing(401, 'bad key')]),
          'model-b': mockModel([answer('ok'), failing(401, 'bad key b')]),
        }),
      }),
    )
    await runWait(engine, runRequest({ llm: [A, B] as never }))
    await waitFor(() => hook.requests.length >= 1)
    expect(hook.requests[0]!.body).toMatchObject({
      event: 'llm_fallback',
      status: 'completed',
      llm_used: { index: 1, provider: 'openai' },
      llm_fallbacks: [{ index: 0, error: { code: 'provider_auth' } }],
    })

    await runWait(engine, runRequest({ llm: [A, B] as never }))
    await waitFor(() => hook.requests.length >= 2)
    expect(hook.requests[1]!.body).toMatchObject({
      event: 'run_failed',
      error: { code: 'provider_auth' },
      llm_fallbacks: [{ index: 0, error: { code: 'provider_auth' } }],
    })
    expect(JSON.stringify(hook.requests.map((r) => r.body))).not.toContain('provider_body')
  })
})
