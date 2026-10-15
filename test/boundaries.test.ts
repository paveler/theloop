/**
 * Regressions at component boundaries: provider error ↔ browser,
 * async result ↔ retention, shutdown ↔ callback, snapshot ↔ backpressure,
 * thinking ↔ SDK, IP literal ↔ egress.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APICallError } from 'ai'
import { createEngine, type Engine } from '../src/app.js'
import type { Llm, ProviderId, RunResult } from '../src/contracts.js'
import { createServer as createTcpServer } from 'node:net'
import { EgressClient } from '../src/egress/client.js'
import { log } from '../src/log.js'
import { buildModel } from '../src/providers/factory.js'
import { SseHub } from '../src/stream/sse.js'
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
  testConfig,
  textChunks,
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

describe('provider_body does not reach the browser (SPEC §4.4, §6.6)', () => {
  const SECRET = 'SYSTEM_PROMPT_NOT_FOR_THE_USER'

  function failingModel() {
    return mockModel(async () =>
      streamFrom([
        START,
        {
          type: 'error',
          error: new APICallError({
            message: 'bad request',
            url: 'https://api.example.com/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: `{"error":"invalid prompt: ${SECRET}"}`,
          }),
        },
      ]),
    )
  }

  it('SSE done and cancel with the run token — without provider_body; with ENGINE_TOKEN — with it', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(failingModel()) }))

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!
    await waitFor(() => engine.deps.registry.get(run_id)?.result != null)

    const stream = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    const sseText = await readSseUntil(stream, (b) => b.includes('event: done'))
    const done = parseSse(sseText).find((e) => e.event === 'done')!
    expect(done.data.error).toMatchObject({ code: 'provider_error', provider_status: 400 })
    expect(done.data.error.provider_body).toBeUndefined()
    expect(sseText).not.toContain(SECRET)

    const browserCancel = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    const browserText = await browserCancel.text()
    expect(browserCancel.status).toBe(200)
    expect(JSON.parse(browserText).error).toMatchObject({ code: 'provider_error' })
    expect(browserText).not.toContain(SECRET)

    const serverCancel = await engine.app.request(`/runs/${run_id}/cancel`, { method: 'POST', headers: bearer() })
    expect(((await serverCancel.json()) as RunResult).error?.provider_body).toContain(SECRET)

    const get = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    expect(((await get.json()) as RunResult).error?.provider_body).toContain(SECRET)

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.error?.provider_body).toContain(SECRET)
  })
})

describe('async result and snapshot are counted in memory (SPEC §11.5)', () => {
  const BIG = 'x'.repeat(200_000)

  it.each(['regular', 'early'] as const)(
    '%s result: the body is released once consumed, a duplicate is recognized by hash',
    async (mode) => {
      const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
      let engineRef: Engine | null = null
      let resultPath = ''
      let resultBody = ''
      const deliver = () =>
        engineRef!.app.request(resultPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: resultBody,
        })

      const tools = trackServer(
        await startServer(async (body, _req, res) => {
          const call = body as { result_url: string; call_id: string }
          const url = new URL(call.result_url)
          resultPath = url.pathname + url.search
          resultBody = JSON.stringify({ call_id: call.call_id, result: { big: BIG } })
          if (mode === 'early') await deliver()
          json(res, 200, { status: 'accepted' })
          if (mode === 'regular') setTimeout(() => void deliver(), 20)
        }),
      )

      const model = mockModel([
        streamFrom([START, toolCall('c1', 't', {}), finish('tool-calls')]),
        streamFrom([START, ...textChunks('done'), finish('stop')]),
      ])
      const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
      engineRef = engine

      const res = await post(engine, {
        ...runRequest({
          tools: [
            { name: 't', input_schema: { type: 'object' }, endpoint: `${tools.url}/t`, effect: 'read', timeout_ms: 2000 },
          ] as never,
        }),
        wait: false,
        callback: { url: `${callbacks.url}/cb` },
      })
      const runId = ((await res.json()) as { run_id: string }).run_id
      await waitFor(() => callbacks.requests.length > 0)
      const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
      expect(payload.tool_calls[0]!.status).toBe('ok')

      const run = engine.deps.registry.get(runId)!
      const call = [...run.calls.values()][0]!
      expect(call.deliveredResult).toBeNull()
      expect(call.resultHash).not.toBeNull()

      const dup = await deliver()
      expect(dup.status).toBe(200)
      expect(await dup.json()).toEqual({ accepted: true, duplicate: true })
    },
  )

  it('resultBytes includes the SSE hub snapshot', async () => {
    const text = 'z'.repeat(50_000)
    const model = mockModel([streamFrom([START, ...textChunks(text), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = (await (await post(engine, runRequest())).json()) as RunResult
    const run = engine.deps.registry.get(result.run_id)!
    // the text is held twice: in the result messages and in the snapshot for reconnects
    expect(run.resultBytes).toBeGreaterThanOrEqual(2 * Buffer.byteLength(text, 'utf8'))
  })
})

describe('shutdown ↔ callback: one delivery task (SPEC §11.1)', () => {
  it('straggler: exactly one attempt, delivered is not overwritten', async () => {
    // the receiver answers with a delay — a second task would have time to start
    const callbacks = trackServer(
      await startServer((_b, _r, res) => {
        setTimeout(() => json(res, 200, { ok: true }), 100)
      }),
    )
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('too late')], abortSignal))
    const engine = createEngine(testConfig({ SHUTDOWN_GRACE_MS: '50' }), { modelFactory: mockFactory(model) })

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const runId = ((await res.json()) as { run_id: string }).run_id
    await waitFor(() => engine.deps.registry.activeCount === 1)

    await engine.shutdown()
    await new Promise((r) => setTimeout(r, 300))

    const run = engine.deps.registry.get(runId)!
    expect(run.result?.finish_reason).toBe('shutdown')
    expect(callbacks.requests).toHaveLength(1)
    expect(run.delivery).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(run.acked).toBe(true)
  })

  it('callback paused between retries: on shutdown one last attempt without waiting', async () => {
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 503, { error: 'down' })))
    const model = mockModel([streamFrom([START, ...textChunks('done'), finish('stop')])])
    const engine = createEngine(testConfig(), { modelFactory: mockFactory(model) })

    const res = await post(engine, { ...runRequest(), wait: false, callback: { url: `${callbacks.url}/cb` } })
    const runId = ((await res.json()) as { run_id: string }).run_id
    const run = engine.deps.registry.get(runId)!
    // the first attempt failed, delivery sleeps 2 s before the second one
    await waitFor(() => callbacks.requests.length === 1 && run.delivery.nextAttemptAt != null)

    const started = Date.now()
    await engine.shutdown()
    expect(Date.now() - started).toBeLessThan(1500)

    expect(callbacks.requests).toHaveLength(2)
    expect(run.delivery).toMatchObject({ status: 'failed', attempts: 2, nextAttemptAt: null })
  })
})

describe('SSE: snapshot ↔ backpressure (SPEC §6.6)', () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<ReturnType<typeof parseSse>> {
    const text = await new Response(stream).text()
    return parseSse(text)
  }

  it('snapshot larger than the queue on a finished run — done arrives', async () => {
    const hub = new SseHub(1024)
    hub.emit('delta', { text: 'z'.repeat(5000) })
    hub.emit('done', { status: 'completed' })

    const events = await readAll(hub.subscribe(null))
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'done'])
    expect(events[0]!.data.text).toHaveLength(5000)
  })

  it('snapshot larger than the queue on a live run — later events and done arrive', async () => {
    const hub = new SseHub(1024)
    hub.emit('delta', { text: 'z'.repeat(5000) })
    const stream = hub.subscribe(null)
    hub.emit('delta', { text: 'more' })
    hub.emit('done', { status: 'completed' })

    const events = await readAll(stream)
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'delta', 'done'])
  })

  it('a subscriber lagging behind the live stream is still disconnected', async () => {
    const hub = new SseHub(1024)
    const stream = hub.subscribe(null) // not read — the queue piles up
    for (let i = 0; i < 20; i++) hub.emit('delta', { text: 'y'.repeat(100) })
    hub.emit('done', { status: 'completed' })

    const events = await readAll(stream)
    expect(events[0]!.event).toBe('snapshot')
    expect(events.some((e) => e.event === 'done')).toBe(false)
    expect(events.filter((e) => e.event === 'delta').length).toBeLessThan(20)
  })
})

describe('thinking ↔ SDK: reaches the request body or is dropped explicitly (SPEC §9.3)', () => {
  /** Runs the request through the real SDK and returns the body that went to fetch. */
  async function sentBody(
    provider: ProviderId,
    modelId = 'm',
    params: Record<string, unknown> = { thinking: { budget_tokens: 10_000 } },
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {}
    const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body ?? '{}'))
      return new Response('{"error":{"message":"stop"}}', { status: 400 })
    }) as unknown as typeof fetch
    const egress = { assertAllowed: () => {}, providerFetchFor: () => fakeFetch } as unknown as EgressClient

    const llm = {
      provider,
      model: modelId,
      api_key: 'k',
      ...(provider === 'openai-compatible' ? { base_url: 'https://llm.example.com/v1' } : {}),
      params,
    } as unknown as Llm
    const resolved = buildModel(llm, testConfig(), egress)
    const model = resolved.model as unknown as {
      doStream: (opts: Record<string, unknown>) => Promise<unknown>
    }
    await model
      .doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        providerOptions: resolved.providerOptions,
      })
      .catch(() => {})
    return body
  }

  it.each(['openai', 'openai-compatible'] as const)('%s: reasoning_effort is sent', async (provider) => {
    expect((await sentBody(provider)).reasoning_effort).toBe('high')
  })

  it('anthropic: extended thinking with a budget, minimax: adaptive without a budget', async () => {
    expect((await sentBody('anthropic')).thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 })
    expect((await sentBody('anthropic', 'claude-sonnet-4-6')).thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 })
    expect((await sentBody('minimax')).thinking).toEqual({ type: 'adaptive' })
  })

  it.each([
    // budget → effort, roughly: < 4000 low, < 16000 medium, otherwise high; xhigh / max are never reached
    ['claude-opus-5-5', 10_000, 'medium'],
    ['claude-fable-5-1', 2_000, 'low'],
    ['claude-mythos-5-1', 4_000, 'medium'],
    ['claude-sonnet-5-5', 16_000, 'high'],
    ['claude-sonnet-5', 15_999, 'medium'],
    ['claude-haiku-5-5', 1_024, 'low'],
    ['claude-opus-5', 32_000, 'high'],
    ['claude-opus-4-7', 100_000, 'high'],
  ] as const)('anthropic %s, budget %d: adaptive + effort %s, budget_tokens is not sent', async (model, budget, effort) => {
    const warn = vi.spyOn(log, 'warn')
    const body = await sentBody('anthropic', model, { thinking: { budget_tokens: budget } })
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort })
    expect(warn).not.toHaveBeenCalledWith('llm_param_unsupported', expect.anything())
    warn.mockRestore()
  })

  it('anthropic, new Claude: the budget is not added to max_tokens; without params.thinking nothing is sent', async () => {
    const withThinking = await sentBody('anthropic', 'claude-opus-5-5')
    const without = await sentBody('anthropic', 'claude-opus-5-5', {})
    expect(without).not.toHaveProperty('thinking')
    expect(without).not.toHaveProperty('output_config')
    expect(withThinking.max_tokens).toBe(without.max_tokens)
  })

  it.each([
    // without thinking: turned off where possible; 5.3 cannot be turned off — effort low instead of the default max
    ['glm-4.7', {}, { thinking: { type: 'disabled' } }],
    ['glm-5.2', {}, { thinking: { type: 'disabled' } }],
    ['glm-5.3', {}, { reasoning_effort: 'low' }],
    ['glm-5.3-flashx', {}, { reasoning_effort: 'low' }],
    // with thinking: turned on; only 5.2+ take the effort from the budget
    ['glm-4.7', { thinking: { budget_tokens: 20_000 } }, { thinking: { type: 'enabled' } }],
    ['glm-5.2', { thinking: { budget_tokens: 5_000 } }, { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['glm-5.3', { thinking: { budget_tokens: 2_000 } }, { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
    ['glm-5.3', { thinking: { budget_tokens: 16_000 } }, { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
  ] as const)('glm %s %j → %j', async (model, params, expected) => {
    const body = await sentBody('glm', model, params)
    expect({ thinking: body.thinking, reasoning_effort: body.reasoning_effort }).toEqual({
      thinking: undefined,
      reasoning_effort: undefined,
      ...expected,
    })
  })

  it.each(['deepseek'] as const)('%s: no mapping — not sent, warn in the journal', async (provider) => {
    const warn = vi.spyOn(log, 'warn')
    const body = await sentBody(provider)
    expect(body.model).toBe('m') // the request was actually built
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(warn).toHaveBeenCalledWith(
      'llm_param_unsupported',
      expect.objectContaining({ param: 'thinking', provider }),
    )
    warn.mockRestore()
  })
})

describe('egress: a private IP literal is refused before connecting (SPEC §11.4)', () => {
  const strict = (allowlist: string) =>
    new EgressClient(testConfig({ ALLOW_INSECURE_EGRESS: '0', EGRESS_ALLOWLIST: allowlist }))

  it.each([
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'https://169.254.169.254/x',
    'https://[::ffff:127.0.0.1]/x', // URL turns it into [::ffff:7f00:1]
  ])(
    '%s in the allowlist — still egress_denied',
    (url) => {
      const egress = strict('127.0.0.1,10.0.0.5,::1,169.254.169.254,::ffff:7f00:1')
      expect(() => egress.assertAllowed(url, 'tool')).toThrow(expect.objectContaining({ code: 'egress_denied' }))
    },
  )

  it('a public IP literal from the allowlist passes', () => {
    expect(strict('8.8.8.8').assertAllowed('https://8.8.8.8/x', 'tool').hostname).toBe('8.8.8.8')
  })

  it('no TCP connection is ever made', async () => {
    let connections = 0
    const server = createTcpServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const port = (server.address() as { port: number }).port

    const egress = strict('127.0.0.1')
    cleanup.push(() => egress.close())
    await expect(
      egress.request({ url: `https://127.0.0.1:${port}/x`, timeoutMs: 1000, maxBytes: 1024, purpose: 'tool' }),
    ).rejects.toMatchObject({ code: 'egress_denied' })
    await new Promise((r) => setTimeout(r, 50))
    expect(connections).toBe(0)
  })
})
