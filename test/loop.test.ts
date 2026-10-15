/**
 * The loop on MockLanguageModelV2 (SPEC §13.2): no network, no keys — tools run on a local
 * http server, the provider is mocked at the LanguageModelV2 level.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { sha256 } from '../src/ids.js'
import { EMPTY_TOOL_RESULT } from '../src/runs/messages.js'
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
  toolCall,
  readSseUntil,
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

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await post(engine, { ...body, wait: true })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

function readTool(url: string, name = 'getStatus', effect: 'read' | 'write' = 'read') {
  return {
    name,
    description: 'test',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    endpoint: `${url}/${name}`,
    effect,
  }
}

describe('loop: tools', () => {
  it('one tool call: the tool runs, the result goes to the model, the run completes', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { state: 'shipped' } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '12345' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Order 12345 has shipped'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    const toolMessage = result.messages[1] as Record<string, any>
    expect(toolMessage.call_id).toBe('c1')
    expect(toolMessage.result).toEqual({ state: 'shipped' })
    expect(result.tool_calls[0]).toMatchObject({ call_id: 'c1', status: 'ok', effect: 'read' })
    expect(tools.requests[0]!.body).toMatchObject({ run_id: result.run_id, call_id: 'c1', attempt: 1 })
  })

  it('parallel calls: results come in the order of the model tool calls', async () => {
    const tools = trackServer(
      await startServer(async (body, _req, res) => {
        const call = body as { call_id: string }
        // the first call answers slower than the second
        if (call.call_id === 'c1') await new Promise((r) => setTimeout(r, 80))
        json(res, 200, { status: 'ok', result: { call: call.call_id } })
      }),
    )
    const model = mockModel([
      streamFrom([
        START,
        toolCall('c1', 'slow', { id: '1' }),
        toolCall('c2', 'fast', { id: '2' }),
        finish('tool-calls'),
      ]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url, 'slow'), readTool(tools.url, 'fast')] as never }),
    )

    const toolMessages = result.messages.filter((m) => m.role === 'tool') as Array<Record<string, any>>
    expect(toolMessages.map((m) => m.call_id)).toEqual(['c1', 'c2'])
    expect(result.tool_calls.map((t) => t.call_id)).toEqual(['c1', 'c2'])
  })

  it('a tool error does not fail the run: the model gets is_error and continues', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'error', error: 'access denied' })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('That did not work, please try again later'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    const toolMessage = result.messages[1] as Record<string, any>
    expect(toolMessage.is_error).toBe(true)
    expect(toolMessage.error).toBe('access denied')
    expect(result.tool_calls[0]!.status).toBe('error')
  })

  it('deferred: the run ends awaiting_tool, operation_id lands in tool_call', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'deferred', operation_id: 'op_42' })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'createRefund', { amount: 100 }), finish('tool-calls')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        idempotency_key: 'msg_1',
        history_revision: 12,
        meta: { session_id: 'sess_1' },
        tools: [readTool(tools.url, 'createRefund', 'write')] as never,
      }),
    )

    expect(result.status).toBe('awaiting_tool')
    expect(result.finish_reason).toBe('deferred')
    // no tool message for deferred: the result arrives with the next run
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(0)
    const assistant = result.messages[0] as Record<string, any>
    expect(assistant.content[0].operation_id).toBe('op_42')
    expect(result.tool_calls[0]).toMatchObject({ status: 'deferred', operation_id: 'op_42', effect: 'write' })
    expect(tools.requests[0]!.body).toMatchObject({ origin_request_id: 'msg_1' })
  })

  it('a write tool answered synchronously: protocol_error, the run does not fail', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { done: true } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'createRefund', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('the tool is broken'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        idempotency_key: 'msg_2',
        history_revision: 1,
        meta: { session_id: 'sess_2' },
        tools: [readTool(tools.url, 'createRefund', 'write')] as never,
      }),
    )

    expect(result.status).toBe('completed')
    expect(result.tool_calls[0]!.status).toBe('protocol_error')
    expect((result.messages[1] as Record<string, any>).error).toBe('tool_protocol_error')
  })

  it('two calls of one write tool in a step: duplicate_write_intent, a read in the same batch runs', async () => {
    const tools = trackServer(
      await startServer((body, _req, res) => {
        const call = body as { tool: string }
        if (call.tool === 'createRefund') return json(res, 200, { status: 'deferred', operation_id: 'op_1' })
        json(res, 200, { status: 'ok', result: { ok: true } })
      }),
    )
    const model = mockModel([
      streamFrom([
        START,
        toolCall('c1', 'createRefund', { amount: 100 }),
        toolCall('c2', 'createRefund', { amount: 200 }),
        toolCall('c3', 'getStatus', {}),
        finish('tool-calls'),
      ]),
      streamFrom([START, ...textChunks('I will make a single call'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        idempotency_key: 'msg_3',
        history_revision: 3,
        meta: { session_id: 'sess_3' },
        tools: [readTool(tools.url, 'createRefund', 'write'), readTool(tools.url, 'getStatus')] as never,
      }),
    )

    expect(result.tool_calls.map((t) => t.status)).toEqual([
      'duplicate_write_intent',
      'duplicate_write_intent',
      'ok',
    ])
    // the write endpoint was never called
    expect(tools.requests.filter((r) => (r.body as { tool: string }).tool === 'createRefund')).toHaveLength(0)
    expect(result.status).toBe('completed')
  })
})

describe('loop: empty results and repeats (SPEC §6.2, §6.7)', () => {
  /** What the model received as tool results at step `step` (0-based). */
  function toolOutputsAt(model: ReturnType<typeof mockModel>, step: number): unknown[] {
    const prompt = model.doStreamCalls[step]!.prompt
    return prompt
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ output: unknown }>)
      .map((p) => p.output)
  }

  it('an empty tool body: the model gets the "no data" marker, the history gets null', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => {
        res.writeHead(200)
        res.end()
      }),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Nothing found'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect((result.messages[1] as Record<string, any>).result).toBeNull()
    expect(toolOutputsAt(model, 1)).toEqual([{ type: 'text', value: EMPTY_TOOL_RESULT }])
  })

  it('a repeated call with the same args does not run: the model gets repeated_call', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok' })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1', kind: 'a' }), finish('tool-calls')]),
      // the same call, keys in a different order
      streamFrom([START, toolCall('c2', 'getStatus', { kind: 'a', id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect(tools.requests).toHaveLength(1)
    const repeat = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c2') as Record<string, any>
    expect(repeat.is_error).toBe(true)
    expect(repeat.error).toMatch(/^repeated_call:/)
    expect(result.tool_calls.map((t) => t.status)).toEqual(['ok', 'error'])
    // after the first repeat the tools are still available
    expect(model.doStreamCalls[2]!.toolChoice?.type).not.toBe('none')
  })

  it('a second repeat: the next step runs with toolChoice none, the run ends with an answer, not max_steps', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: [] })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c3', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data for this order'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 8 } as never }),
    )

    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    expect(result.timing.steps).toBe(4)
    expect(tools.requests).toHaveLength(1)
    expect(model.doStreamCalls[2]!.toolChoice?.type).not.toBe('none')
    expect(model.doStreamCalls[3]!.toolChoice).toEqual({ type: 'none' })
  })

  it('a provider that calls tools even on none (GLM) gets no tools on such a step', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: [] })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c3', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data for this order'), finish('stop')]),
    ])
    const engine = track(
      createEngine(testConfig(), { modelFactory: mockFactory(model, { honorsToolChoiceNone: false }) }),
    )

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 8 } as never }),
    )

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls[2]!.tools?.map((t) => t.name)).toEqual(['getStatus'])
    expect(model.doStreamCalls[3]!.tools ?? []).toEqual([])
  })

  it('a second empty result of one tool (other args): toolChoice none from then on, a text answer', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: [] })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '2' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data for either order'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect(result.timing.steps).toBe(3)
    expect(tools.requests).toHaveLength(2)
    expect(model.doStreamCalls[1]!.toolChoice?.type).not.toBe('none')
    expect(model.doStreamCalls[2]!.toolChoice).toEqual({ type: 'none' })
  })

  it('one empty result per tool, and an empty result after data: tools stay enabled', async () => {
    let statusCalls = 0
    const tools = trackServer(
      await startServer((body, _req, res) => {
        const call = body as { tool: string }
        if (call.tool === 'getStatus' && statusCalls++ === 0) return json(res, 200, { status: 'ok', result: { state: 'shipped' } })
        json(res, 200, { status: 'ok', result: [] })
      }),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '2' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c3', 'getDocs', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url), readTool(tools.url, 'getDocs')] as never }),
    )

    expect(result.status).toBe('completed')
    expect(tools.requests).toHaveLength(3)
    expect(model.doStreamCalls.every((c) => c.toolChoice?.type !== 'none')).toBe(true)
  })

  it('after duplicate_write_intent a reconciled call runs, even if it matches a rejected one', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'deferred', operation_id: 'op_1' })),
    )
    const model = mockModel([
      streamFrom([
        START,
        toolCall('c1', 'createRefund', { id: '100' }),
        toolCall('c2', 'createRefund', { id: '200' }),
        finish('tool-calls'),
      ]),
      streamFrom([START, toolCall('c3', 'createRefund', { id: '100' }), finish('tool-calls')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        idempotency_key: 'msg_dup',
        history_revision: 1,
        meta: { session_id: 'sess_dup' },
        tools: [readTool(tools.url, 'createRefund', 'write')] as never,
      }),
    )

    expect(result.status).toBe('awaiting_tool')
    expect(tools.requests).toHaveLength(1)
    expect(result.tool_calls.map((t) => t.status)).toEqual([
      'duplicate_write_intent',
      'duplicate_write_intent',
      'deferred',
    ])
  })

  it('other args are not a repeat: every call reaches the tool', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { state: 'delivered' } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '2' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c3', 'getStatus', { id: '3' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data for any of them'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(result.status).toBe('completed')
    expect(tools.requests).toHaveLength(3)
    expect(result.tool_calls.map((t) => t.status)).toEqual(['ok', 'ok', 'ok'])
    expect(model.doStreamCalls.every((c) => c.toolChoice?.type !== 'none')).toBe(true)
  })
})

describe('loop: async tools (accepted)', () => {
  it('accepted, then tool-result: the first is accepted, a duplicate with the same body is ok, a different body is result_mismatch', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'accepted' })))
    const callbacks = trackServer(await startServer((_body, _req, res) => json(res, 200, { ok: true })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({ tools: [{ ...readTool(tools.url), timeout_ms: 5000 }] as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    expect(res.status).toBe(202)
    const { run_id } = (await res.json()) as { run_id: string }

    await waitFor(() => tools.requests.length > 0)

    const first = await engine.app.request(`/runs/${run_id}/tool-result`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ call_id: 'c1', result: { state: 'ready' } }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ accepted: true })

    const duplicate = await engine.app.request(`/runs/${run_id}/tool-result`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ call_id: 'c1', result: { state: 'ready' } }),
    })
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true })

    const mismatch = await engine.app.request(`/runs/${run_id}/tool-result`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ call_id: 'c1', result: { state: 'different' } }),
    })
    expect(mismatch.status).toBe(409)
    expect(((await mismatch.json()) as any).error.code).toBe('result_mismatch')

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.status).toBe('completed')
    expect((payload.messages[1] as Record<string, any>).result).toEqual({ state: 'ready' })
  })

  it('a call timeout closes the call: a late tool-result gets 409 call_closed, the run continues', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'accepted' })))
    const callbacks = trackServer(await startServer((_body, _req, res) => json(res, 200, { ok: true })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', {}), finish('tool-calls')]),
      streamFrom([START, ...textChunks('the tool did not answer'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({ tools: [{ ...readTool(tools.url), timeout_ms: 60 }] as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id } = (await res.json()) as { run_id: string }

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.tool_calls[0]!.status).toBe('timeout')
    expect((payload.messages[1] as Record<string, any>).error).toBe('tool_timeout')

    const late = await engine.app.request(`/runs/${run_id}/tool-result`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ call_id: 'c1', result: { late: true } }),
    })
    expect(late.status).toBe(409)
    expect(((await late.json()) as any).error.code).toBe('call_closed')
  })
})

describe('loop: provider interruptions (SPEC §11.3)', () => {
  it('an interruption before the first content event: a retry, both attempts in usage', async () => {
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      if (attempts === 1) {
        return streamFrom([START, { type: 'error', error: new Error('socket hang up') }])
      }
      return streamFrom([START, ...textChunks('on the second attempt'), finish('stop')])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())

    expect(attempts).toBe(2)
    expect(result.status).toBe('completed')
    expect(result.usage.calls).toHaveLength(2)
    expect(result.usage.calls[0]!.status).toBe('unknown')
    expect(result.usage.calls[1]!.status).toBe('ok')
    expect(result.usage.total.unknown_calls).toBe(1)
  })

  it('an interruption after the first delta: provider_stream_interrupted without a retry, tool calls not executed', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: {} })))
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      return streamFrom([
        START,
        ...textChunks('started answering'),
        toolCall('c1', 'getStatus', {}),
        { type: 'error', error: new Error('connection reset') },
      ] as LanguageModelV2StreamPart[])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    expect(attempts).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.finish_reason).toBe('provider_stream_interrupted')
    expect(result.error?.code).toBe('provider_stream_interrupted')
    expect(tools.requests).toHaveLength(0) // tools start only after finish-step
    const assistant = result.messages[0] as Record<string, any>
    expect(assistant.partial).toBe(true)
    expect(assistant.content[0].text).toBe('started answering')
    const toolMessage = result.messages[1] as Record<string, any>
    expect(toolMessage.error).toBe('not_executed: stream_interrupted')
    expect(result.usage.calls[0]!.status).toBe('unknown')
  })

  it('provider_auth is not retried and fails the run', async () => {
    const { APICallError } = await import('ai')
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      return streamFrom([
        START,
        {
          type: 'error',
          error: new APICallError({
            message: 'invalid api key',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 401,
            responseBody: '{"error":"invalid x-api-key sk-ant-secret123456"}',
          }),
        },
      ])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())

    expect(attempts).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_auth')
    expect(result.error?.provider_status).toBe(401)
    expect(result.error?.provider_body).not.toContain('sk-ant-secret123456')
    expect(result.usage.calls[0]!.status).toBe('failed')
    expect(result.usage.total.input_tokens).toBe(0)
  })
})

describe('loop: limits at the step boundary (SPEC §10.1)', () => {
  it('max_steps: the tools of the last allowed step do not run', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: {} })))
    const model = mockModel(async () =>
      streamFrom([START, toolCall(`c${Math.random()}`, 'getStatus', {}), finish('tool-calls')]),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }),
    )

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.timing.steps).toBe(2)
    expect(tools.requests).toHaveLength(1) // step 1 only
    const last = result.messages[result.messages.length - 1] as Record<string, any>
    expect(last.error).toBe('not_executed: max_steps')
    expect(result.tool_calls.at(-1)!.status).toBe('not_executed')
  })

  it('max_tool_calls: a batch larger than the remainder does not run at all', async () => {
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: {} })))
    const model = mockModel([
      streamFrom([
        START,
        toolCall('c1', 'getStatus', {}),
        toolCall('c2', 'getStatus', {}),
        toolCall('c3', 'getStatus', {}),
        finish('tool-calls'),
      ]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_tool_calls: 2 } as never }),
    )

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_tool_calls')
    expect(tools.requests).toHaveLength(0)
    expect(result.tool_calls.map((t) => t.status)).toEqual(['not_executed', 'not_executed', 'not_executed'])
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(3)
  })

  it('max_tokens: finish_reason length keeps the partial text, stopped_limit', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('a very long ans'), finish('length')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ limits: { max_tokens: 16 } as never }))

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_tokens')
    const assistant = result.messages[0] as Record<string, any>
    expect(assistant.partial).toBe(true)
    expect(assistant.content[0].text).toBe('a very long ans')
  })

  it('max_total_tokens: the budget does not allow a call, the run stops before the provider', async () => {
    let calls = 0
    const model = mockModel(async () => {
      calls++
      return streamFrom([START, ...textChunks('answer'), finish('stop')])
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ limits: { max_total_tokens: 10, max_tokens: 4096 } as never }),
    )

    expect(calls).toBe(0)
    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_total_tokens')
    expect(result.messages).toHaveLength(0)
  })

  it('max_cost: an expensive price stops the run at the budget', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('answer'), finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          api_key: 'sk-test',
          pricing: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, per_tokens: 1_000_000, currency: 'USD', version: '2026-09' },
        } as never,
        limits: { max_cost: 0.00001 } as never,
      }),
    )

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_cost')
  })
})

describe('loop: stop and timeout (SPEC §6.5, §10)', () => {
  it('cancel mid-stream: partial + synthetic tool errors + an unknown attempt', async () => {
    const callbacks = trackServer(await startServer((_body, _req, res) => json(res, 200, { ok: true })))
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream(
        [START, ...textChunks('started typing'), toolCall('c1', 'getStatus', {})],
        abortSignal,
      ),
    )
    const tools = trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: {} })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const res = await post(engine, {
      ...runRequest({ tools: [readTool(tools.url)] as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })
    const { run_id, cancel_url } = (await res.json()) as { run_id: string; cancel_url: string }
    const token = new URL(cancel_url).searchParams.get('token')!

    // wait until the text actually reaches SSE: only then does cancel make sense
    const stream = await engine.app.request(`/runs/${run_id}/stream?token=${token}`)
    await readSseUntil(stream, (buf) => buf.includes('started typing'))

    const cancelled = await engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    expect(cancelled.status).toBe(200)
    const browserBody = (await cancelled.json()) as RunResult
    expect(browserBody.status).toBe('cancelled')
    // messages are not returned for the run token: they hold tool results and reasoning
    expect(browserBody.messages).toBeUndefined()

    const full = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
    const result = (await full.json()) as RunResult

    expect(result.status).toBe('cancelled')
    expect(result.finish_reason).toBe('user')
    const assistant = result.messages[0] as Record<string, any>
    expect(assistant.partial).toBe(true)
    expect(assistant.content[0].text).toBe('started typing')
    const toolMessage = result.messages[1] as Record<string, any>
    expect(toolMessage.error).toBe('cancelled')
    expect(result.tool_calls[0]!.status).toBe('cancelled')
    expect(result.usage.calls[0]!.status).toBe('unknown')
    expect(result.usage.calls[0]!.estimated).toBe(true)
    expect(tools.requests).toHaveLength(0)
  })

  it('cancel is idempotent: on a finished run it returns the same result', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('a quick answer'), finish('stop')]))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())
    const cancelled = await engine.app.request(`/runs/${result.run_id}/cancel`, {
      method: 'POST',
      headers: bearer(),
    })
    expect(cancelled.status).toBe(200)
    const body = (await cancelled.json()) as RunResult
    expect(body.status).toBe('completed')
    expect(body.finish_reason).toBe('end_turn')
  })

  it('run_timeout: the partial is kept, status failed', async () => {
    const callbacks = trackServer(await startServer((_body, _req, res) => json(res, 200, { ok: true })))
    const model = mockModel(async ({ abortSignal }) =>
      hangingStream([START, ...textChunks('thinking it over')], abortSignal),
    )
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    await post(engine, {
      ...runRequest({ limits: { timeout_ms: 150 } as never }),
      wait: false,
      callback: { url: `${callbacks.url}/cb` },
    })

    await waitFor(() => callbacks.requests.length > 0)
    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.status).toBe('failed')
    expect(payload.finish_reason).toBe('run_timeout')
    expect(payload.error?.code).toBe('run_timeout')
    expect((payload.messages[0] as Record<string, any>).partial).toBe(true)
  })
})

describe('loop: prompt cache (SPEC §9.1, §9.3, §9.4)', () => {
  type PromptPart = { type: string; text?: string; providerOptions?: Record<string, any> }
  const parts = (message: { content: unknown }) => message.content as PromptPart[]
  const CC = { anthropic: { cacheControl: { type: 'ephemeral' } } }

  const history = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ]

  it('the date goes at the end of the last user message, not in system; the same line on tool steps', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { a: 1 } })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ messages: history, tools: [readTool(tools.url)] } as never))

    expect(result.status).toBe('completed')
    const lastUserText = (step: number) => {
      const users = model.doStreamCalls[step]!.prompt.filter((m) => m.role === 'user')
      return parts(users.at(-1)!).map((p) => p.text).join('')
    }
    for (const step of [0, 1]) {
      const prompt = model.doStreamCalls[step]!.prompt
      expect(prompt.filter((m) => m.role === 'system').map((m) => m.content)).toEqual(['You are an assistant.'])
      expect(lastUserText(step)).toMatch(/^second question\n\n\[engine\] Current date and time: \S+ \(UTC\)\.$/)
      // older user messages carry no date
      expect(parts(prompt.find((m) => m.role === 'user')!).map((p) => p.text)).toEqual(['first question'])
    }
    expect(lastUserText(1)).toBe(lastUserText(0))
    // the date does not get into the client history
    expect(JSON.stringify(result.messages)).not.toContain('[engine]')
  })

  it('cache_control: a breakpoint before the date and at the tail of a tool step', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { a: 1 } })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(
      createEngine(testConfig(), { modelFactory: mockFactory(model, { supportsCacheControl: true }) }),
    )

    const result = await runWait(engine, runRequest({ messages: history, tools: [readTool(tools.url)] } as never))

    expect(result.status).toBe('completed')
    const anchorParts = (step: number) =>
      parts(model.doStreamCalls[step]!.prompt.filter((m) => m.role === 'user').at(-1)!)
    expect(anchorParts(0).map((p) => p.providerOptions)).toEqual([CC, undefined])
    expect(anchorParts(0)[1]!.text).toMatch(/^\[engine\] Current date and time:/)
    // step 1: the breakpoint before the date stays, the second one is on the tool result
    expect(anchorParts(1)[0]!.providerOptions).toEqual(CC)
    const toolMessage = model.doStreamCalls[1]!.prompt.at(-1)!
    expect(toolMessage.role).toBe('tool')
    expect(parts(toolMessage).at(-1)!.providerOptions).toEqual(CC)
    // system is one cacheable block, without a date
    const system = model.doStreamCalls[1]!.prompt.filter((m) => m.role === 'system')
    expect(system.map((m) => m.content)).toEqual(['You are an assistant.'])
  })

  it('X-Session-ID: a hash of session_id on every step; without a session, a hash of run_id', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { a: 1 } })))
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
      streamFrom([START, ...textChunks('no session'), finish('stop')]),
    ])
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: mockFactory(model, { sessionHeader: 'X-Session-ID' }),
      }),
    )
    const header = (step: number) => {
      const headers = model.doStreamCalls[step]!.headers ?? {}
      return Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-session-id')?.[1]
    }

    const withSession = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)], meta: { session_id: 'chat-1' } } as never),
    )
    expect(withSession.status).toBe('completed')
    expect(header(0)).toBe(sha256('chat-1').slice(0, 32))
    expect(header(1)).toBe(header(0))

    const noSession = await runWait(engine, runRequest())
    expect(noSession.status).toBe('completed')
    expect(header(2)).toBe(sha256(noSession.run_id).slice(0, 32))
  })

  it('no header without sessionHeader', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    await runWait(engine, runRequest())
    const headers = model.doStreamCalls[0]!.headers ?? {}
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-session-id')
  })
})

describe('loop: date from created_at (SPEC §9.4)', () => {
  it('user messages with created_at carry their own date, no current time in the prompt', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first' }], created_at: '2026-10-12T12:00:00Z' },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'second' }], created_at: '2026-10-12T12:05:00Z' },
        ],
        // a non-UTC zone, so the stamp is converted to the run's offset
        meta: { timezone: 'Asia/Tokyo' },
      } as never),
    )

    expect(result.status).toBe('completed')
    const prompt = model.doStreamCalls[0]!.prompt
    const users = prompt
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as Array<{ text?: string }>).map((p) => p.text).join(''))
    expect(users).toEqual([
      'first\n\n[engine] Message date and time: 2026-10-12T21:00:00+09:00 (Asia/Tokyo).',
      'second\n\n[engine] Message date and time: 2026-10-12T21:05:00+09:00 (Asia/Tokyo).',
    ])
    expect(prompt.filter((m) => m.role === 'system').map((m) => m.content)).toEqual(['You are an assistant.'])
    expect(JSON.stringify(prompt)).not.toContain('Current date and time')
  })
})

describe('loop: tool order (SPEC §9.3)', () => {
  it('tools go to the model sorted by name, whatever order they were sent in', async () => {
    const model = mockModel([
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(
      createEngine(testConfig(), { modelFactory: mockFactory(model, { supportsCacheControl: true }) }),
    )
    const tool = (name: string) => readTool('https://tools.example.com', name)

    await runWait(engine, runRequest({ tools: [tool('trackDelivery'), tool('getOrder'), tool('findProducts')] } as never))
    await runWait(engine, runRequest({ tools: [tool('findProducts'), tool('trackDelivery'), tool('getOrder')] } as never))

    const names = (call: number) => model.doStreamCalls[call]!.tools?.map((t) => t.name)
    expect(names(0)).toEqual(['findProducts', 'getOrder', 'trackDelivery'])
    expect(names(1)).toEqual(names(0))
    // the cache breakpoint is on the last one by name
    const last = model.doStreamCalls[1]!.tools!.at(-1) as { providerOptions?: unknown }
    expect(last.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })
})
