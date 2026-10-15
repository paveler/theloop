/**
 * result.context — how much context is used after a run (SPEC §7): the full prompt of the
 * last call + its answer + the tool messages after it, not usage.total.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { APICallError } from 'ai'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { estimateMessageTokens } from '../src/runs/messages.js'
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
  testConfig,
  textChunks,
  toolCall,
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

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...body, wait: true }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

function readTool(url: string) {
  return {
    name: 'getStatus',
    description: 'test',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    endpoint: `${url}/getStatus`,
    effect: 'read',
  }
}

describe('result.context (SPEC §7)', () => {
  it('one call: input + cache_read + output; the window is the one the engine trims by', async () => {
    // openai-compatible semantics: prompt_tokens includes the cache, the engine subtracts it (§8.1)
    const model = mockModel([
      streamFrom([START, ...textChunks("It's 00:13."), finish('stop', { inputTokens: 6477, outputTokens: 13, cachedInputTokens: 5961 })]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model, { contextWindow: 32_000 }) }))

    const result = await runWait(engine, runRequest())

    expect(result.usage.calls[0]).toMatchObject({ input_tokens: 516, cache_read_tokens: 5961, output_tokens: 13 })
    expect(result.context).toEqual({ used_tokens: 6490, window_tokens: 32_000, estimated: false })
  })

  it('several steps: the last call, not the sum in usage.total', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { state: 'shipped' } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls', { inputTokens: 1000, outputTokens: 20 })]),
      streamFrom([START, ...textChunks('Shipped.'), finish('stop', { inputTokens: 1100, outputTokens: 30 })]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect(result.usage.total.input_tokens).toBe(2100)
    expect(result.context).toEqual({ used_tokens: 1130, window_tokens: 200_000, estimated: false })
  })

  it('tool messages after the last call are added as an estimate', async () => {
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls', { inputTokens: 1000, outputTokens: 20 })]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool('https://tools.example.com')] as never, limits: { max_steps: 1 } as never }),
    )

    expect(result.status).toBe('stopped_limit')
    const toolMessage = result.messages.find((m) => m.role === 'tool')!
    expect(result.context).toEqual({
      used_tokens: 1020 + estimateMessageTokens(toolMessage),
      window_tokens: 200_000,
      estimated: true,
    })
  })

  it('the provider never answered: an estimate over the whole history', async () => {
    const model = mockModel(async () =>
      streamFrom([
        START,
        {
          type: 'error',
          error: new APICallError({
            message: 'bad request',
            url: 'https://api.example.com/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: '{"error":"bad"}',
          }),
        },
      ]),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const request = runRequest()

    const result = await runWait(engine, request)

    expect(result.status).toBe('failed')
    expect(result.usage.calls.every((c) => c.status === 'failed')).toBe(true)
    const history = (request.messages as never[]).reduce((acc, m) => acc + estimateMessageTokens(m), 0)
    expect(result.context.estimated).toBe(true)
    expect(result.context.used_tokens).toBeGreaterThan(history)
  })
})
