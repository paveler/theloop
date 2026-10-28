/**
 * The text-only final step on max_steps / max_tool_calls (SPEC §10.1, RFC 0002 part A): the
 * last step goes with tool_choice none and an engine note, and a run that hits one of these
 * limits always ends with an answer — the model's or the engine's fallback.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import type { LogEntry } from '../src/log-buffer.js'
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

async function toolServer(): Promise<LocalServer> {
  const server = await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { n: 1 } }))
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

async function logs(engine: Engine, runId: string, events: string): Promise<LogEntry[]> {
  const res = await engine.app.request(`/logs?run_id=${runId}&event=${events}`, { headers: bearer() })
  return ((await res.json()) as { entries: LogEntry[] }).entries
}

function readTool(url: string) {
  return {
    name: 'getStatus',
    description: 'test',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    endpoint: `${url}/getStatus`,
    effect: 'read' as const,
  }
}

const callStep = (id: string, args: Record<string, unknown> = { id }) =>
  streamFrom([START, toolCall(id, 'getStatus', args), finish('tool-calls')])
const textStep = (text: string) => streamFrom([START, ...textChunks(text), finish('stop')])

function lastText(result: RunResult): string {
  const last = result.messages.at(-1) as { role: string; content?: Array<{ type: string; text?: string }> }
  expect(last.role).toBe('assistant')
  return (last.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('')
}

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  const user = prompt.filter((m) => m.role === 'user').at(-1)
  const parts = (user?.content ?? []) as Array<{ type: string; text?: string }>
  return parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
}

describe('final answer on max_steps (SPEC §10.1 rule 1)', () => {
  it('the last step goes with tool_choice none and the note; the model answers → completed, limit_reached', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), callStep('c2'), textStep('Found two of three, here is what is left.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 3 } as never }))

    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    expect(result.limit_reached).toBe('max_steps')
    expect(result.answer_source).toBeUndefined()
    expect(result.timing.steps).toBe(3)
    expect(tools.requests).toHaveLength(2)
    expect(model.doStreamCalls[1]!.toolChoice?.type).not.toBe('none')
    expect(model.doStreamCalls[2]!.toolChoice).toEqual({ type: 'none' })
    expect(lastUserText(model.doStreamCalls[2]!.prompt as never)).toContain('[engine] Step limit reached')
    // the note is ephemeral: not in the run's messages
    expect(JSON.stringify(result.messages)).not.toContain('Step limit reached')
    expect(lastText(result)).toBe('Found two of three, here is what is left.')

    const entries = await logs(engine, result.run_id, 'step_start,final_answer,run_done')
    const finalStart = entries.find((e) => e.event === 'step_start' && e.step === 3)
    expect(finalStart).toMatchObject({ final_answer_step: true })
    expect((finalStart!.content as { engine_note: string }).engine_note).toContain('Step limit reached')
    expect(entries.find((e) => e.event === 'final_answer')).toMatchObject({ limit: 'max_steps', outcome: 'model' })
    expect(entries.find((e) => e.event === 'run_done')).toMatchObject({ limit_reached: 'max_steps' })
  })

  it('a provider without tool_choice none gets no tools on the final step', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), textStep('Answer.')])
    const engine = track(
      createEngine(testConfig(), { modelFactory: mockFactory(model, { honorsToolChoiceNone: false }) }),
    )

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }))

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls[0]!.tools?.length).toBe(1)
    expect(model.doStreamCalls[1]!.tools ?? []).toHaveLength(0)
  })

  it('the provider still calls tools on the final step → sealed not_executed, stopped_limit with the fallback', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), callStep('c2')])
    const engine = track(
      createEngine(testConfig(), { modelFactory: mockFactory(model, { honorsToolChoiceNone: false }) }),
    )

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }))

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.answer_source).toBe('fallback')
    expect(result.limit_reached).toBeUndefined()
    expect(tools.requests).toHaveLength(1)
    const sealed = result.messages.find((m) => m.role === 'tool' && (m as { call_id: string }).call_id === 'c2')
    expect(sealed).toMatchObject({ is_error: true, error: 'not_executed: max_steps' })
    expect(lastText(result)).toBe('I ran out of steps before finishing. Please send the request again, or narrow it down.')

    const entries = await logs(engine, result.run_id, 'final_answer')
    expect(entries[0]).toMatchObject({ limit: 'max_steps', outcome: 'fallback', reason: 'tool_calls_ignored_none' })
  })

  it('the model calls a tool despite tool_choice none (the SDK refuses it) → fallback at once, no retries', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), callStep('c2'), textStep('never reached')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }))

    expect(model.doStreamCalls).toHaveLength(2)
    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.answer_source).toBe('fallback')
    // the refused attempt may have been generated: billed as unknown
    expect(result.usage.calls.at(-1)!.status).toBe('unknown')
    const entries = await logs(engine, result.run_id, 'final_answer')
    expect(entries[0]).toMatchObject({ outcome: 'fallback', reason: 'tool_calls_ignored_none' })
  })

  it('an empty final step → fallback in the run locale (ru)', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), streamFrom([START, finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never, meta: { locale: 'ru' } } as never),
    )

    expect(result.status).toBe('stopped_limit')
    expect(result.answer_source).toBe('fallback')
    expect(lastText(result)).toBe('Не успел закончить за отведённые шаги. Отправьте запрос ещё раз или уточните его.')
    expect(lastUserText(model.doStreamCalls[1]!.prompt as never)).toContain('[engine] Лимит шагов исчерпан')
  })

  it('a provider failure on the final step → fallback, not failed', async () => {
    const tools = await toolServer()
    let calls = 0
    const model = mockModel(async () => {
      calls++
      if (calls === 1) return callStep('c1')
      throw Object.assign(new Error('bad request'), { statusCode: 400 })
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }))

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.answer_source).toBe('fallback')
    expect(result.error).toBeNull()
    const entries = await logs(engine, result.run_id, 'final_answer')
    expect(entries[0]).toMatchObject({ outcome: 'fallback', reason: 'provider_error' })
  })

  it('a budget exhausted before the final step → fallback without a provider call', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls', { inputTokens: 900, outputTokens: 50 })]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [readTool(tools.url)] as never,
        limits: { max_steps: 2, max_tokens: 100, max_total_tokens: 1100 } as never,
      }),
    )

    expect(model.doStreamCalls).toHaveLength(1)
    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_total_tokens')
    expect(result.answer_source).toBe('fallback')
    const entries = await logs(engine, result.run_id, 'final_answer')
    expect(entries[0]).toMatchObject({ limit: 'max_steps', outcome: 'fallback', reason: 'budget' })
  })

  it('max_steps = 1 → unchanged: no text-only step, the single step is the run', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 1 } as never }))

    expect(model.doStreamCalls[0]!.toolChoice?.type).not.toBe('none')
    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.answer_source).toBeUndefined()
    expect(result.messages.at(-1)).toMatchObject({ role: 'tool', error: 'not_executed: max_steps' })
  })

  it('final_answer: false → the pre-1.2 behavior: no text-only step, no answer', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), callStep('c2')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2, final_answer: false } as never }),
    )

    expect(model.doStreamCalls[1]!.toolChoice?.type).not.toBe('none')
    expect(result.status).toBe('stopped_limit')
    expect('answer_source' in result).toBe(false)
    expect('limit_reached' in result).toBe(false)
    expect(result.messages.at(-1)).toMatchObject({ role: 'tool', error: 'not_executed: max_steps' })
  })

  it('the format gate applies to the final text', async () => {
    const tools = await toolServer()
    const bad = 'Done.\n\n```card\n{"title": 1}\n```'
    const good = '```card\n{"title": "ok"}\n```'
    const model = mockModel([callStep('c1'), textStep(bad), textStep(good)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [readTool(tools.url)] as never,
        limits: { max_steps: 2 } as never,
        output_checks: [
          {
            fence: 'card',
            schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
            max_repairs: 1,
          },
        ],
      } as never),
    )

    expect(result.status).toBe('completed')
    expect(result.limit_reached).toBe('max_steps')
    expect(result.output_checks).toEqual([expect.objectContaining({ fence: 'card', status: 'repaired', attempts: 1 })])
    expect(model.doStreamCalls).toHaveLength(3)
  })
})

describe('final answer on max_tool_calls (SPEC §10.1 rule 2)', () => {
  it('a batch over the remainder is not executed; the next step is text-only → completed, limit_reached', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), toolCall('c2', 'getStatus', { id: '2' }), toolCall('c3', 'getStatus', { id: '3' }), finish('tool-calls')]),
      textStep('I could not check all three.'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_tool_calls: 2 } as never }))

    expect(tools.requests).toHaveLength(0)
    expect(result.tool_calls.map((t) => t.status)).toEqual(['not_executed', 'not_executed', 'not_executed'])
    expect(result.status).toBe('completed')
    expect(result.limit_reached).toBe('max_tool_calls')
    expect(model.doStreamCalls[1]!.toolChoice).toEqual({ type: 'none' })
    expect(lastUserText(model.doStreamCalls[1]!.prompt as never)).toContain('[engine] Tool call limit reached')
    expect(lastText(result)).toBe('I could not check all three.')
  })

  it('max_tool_calls used up exactly → the following step is text-only', async () => {
    const tools = await toolServer()
    const model = mockModel([callStep('c1'), textStep('One status checked.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_tool_calls: 1 } as never }))

    expect(tools.requests).toHaveLength(1)
    expect(model.doStreamCalls[1]!.toolChoice).toEqual({ type: 'none' })
    expect(result.status).toBe('completed')
    expect(result.limit_reached).toBe('max_tool_calls')
  })

  it('the text-only step returns nothing → stopped_limit / max_tool_calls with the fallback', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), toolCall('c2', 'getStatus', { id: '2' }), finish('tool-calls')]),
      streamFrom([START, finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, limits: { max_tool_calls: 1 } as never }))

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_tool_calls')
    expect(result.answer_source).toBe('fallback')
  })
})
