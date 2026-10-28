/**
 * Presentation invariants (SPEC §5.4, §6.7, §6.9; RFC 0003): one presentation per run,
 * blocks belong to the final answer, configurable repeat tolerance, grounded values.
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

/** Tool server: `lookup` returns codes, `fail` errors, everything else returns a small list. */
async function toolServer(): Promise<LocalServer> {
  const server = await startServer((_body, req, res) => {
    if (req.url?.startsWith('/lookup')) return json(res, 200, { status: 'ok', result: { area: 'North', codes: ['82', 7] } })
    if (req.url?.startsWith('/fail')) return json(res, 200, { status: 'error', error: 'boom' })
    return json(res, 200, { status: 'ok', result: [{ id: 'a' }] })
  })
  cleanup.push(() => server.close())
  return server
}

function tool(url: string, name: string, presents = false) {
  return {
    name,
    description: 'test',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    endpoint: `${url}/${name}`,
    effect: 'read' as const,
    ...(presents ? { presents: true } : {}),
  }
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

const calls = (...items: Array<[string, string, Record<string, unknown>?]>) =>
  streamFrom([START, ...items.map(([id, name, args]) => toolCall(id, name, args ?? { q: id })), finish('tool-calls')])
const text = (t: string) => streamFrom([START, ...textChunks(t), finish('stop')])
const withCalls = (t: string, ...items: Array<[string, string, Record<string, unknown>?]>) =>
  streamFrom([START, ...textChunks(t), ...items.map(([id, name, args]) => toolCall(id, name, args ?? { q: id })), finish('tool-calls')])

const card = (codes: unknown[]) => '```card\n' + JSON.stringify({ codes }) + '\n```'
const CARD_SCHEMA = {
  type: 'object',
  required: ['codes'],
  properties: { codes: { type: 'array', items: { type: ['string', 'number'] } } },
}

function assistantText(result: RunResult, index = -1): string {
  const messages = result.messages.filter((m) => m.role === 'assistant')
  const message = messages.at(index) as { content: Array<{ type: string; text?: string }> }
  return message.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
}

describe('part A: one presentation per run (SPEC §6.9)', () => {
  it('two presenting calls in one step: the first runs, the second is refused before its endpoint', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'show_items'], ['c2', 'show_more']), text('Here they are.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'show_items', true), tool(tools.url, 'show_more', true)] as never,
        limits: { max_presentations: 1 } as never,
      }),
    )

    expect(tools.requests.map((r) => r.path)).toEqual(['/show_items'])
    expect(result.tool_calls.map((t) => t.status)).toEqual(['ok', 'presentation_limit'])
    const refused = result.messages.find((m) => m.role === 'tool' && (m as { call_id: string }).call_id === 'c2')
    expect(refused).toMatchObject({ is_error: true })
    expect((refused as { error: string }).error).toMatch(/^presentation_limit: show_more was not called/)
    expect(result.presentations).toEqual([{ kind: 'tool', name: 'show_items', call_id: 'c1' }])
    // spent: presenting tools are gone from the next step
    expect(model.doStreamCalls[1]!.tools ?? []).toHaveLength(0)
    const entries = await logs(engine, result.run_id, 'presentation,presentation_limit')
    expect(entries.map((e) => e.event)).toEqual(['presentation_limit', 'presentation'])
  })

  it('a hidden presenting tool called anyway is refused; repeating the refused call counts as a repeat', async () => {
    const tools = await toolServer()
    const model = mockModel([
      calls(['c1', 'show_items', { q: 'x' }]),
      calls(['c2', 'show_items', { q: 'y' }], ['c3', 'lookup']),
      calls(['c4', 'show_items', { q: 'y' }]),
      text('Done.'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'show_items', true), tool(tools.url, 'lookup')] as never,
        limits: { max_presentations: 1, max_repeated_calls: 0 } as never,
      }),
    )

    expect(model.doStreamCalls[1]!.tools?.map((t) => t.name)).toEqual(['lookup'])
    expect(tools.requests.map((r) => r.path)).toEqual(['/show_items', '/lookup'])
    expect(result.tool_calls.map((t) => t.status)).toEqual(['ok', 'presentation_limit', 'ok', 'error'])
    // the repeat of the refused call disabled tools (max_repeated_calls: 0)
    expect(model.doStreamCalls[3]!.toolChoice).toEqual({ type: 'none' })
    expect(result.status).toBe('completed')
  })

  it('a deferred presenting tool activated by a skill after the budget is spent stays hidden', async () => {
    const tools = await toolServer()
    const model = mockModel([
      calls(['c1', 'show_items']),
      calls(['c2', 'load_skill', { name: 'catalog' }]),
      text('Done.'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'show_items', true), { ...tool(tools.url, 'show_more', true), defer_loading: true }] as never,
        skills: [{ name: 'catalog', description: 'Catalog.', body: '# Catalog', tools: ['show_more'] }] as never,
        limits: { max_presentations: 1 } as never,
      }),
    )

    expect(result.status).toBe('completed')
    expect((model.doStreamCalls[2]!.tools ?? []).map((t) => t.name)).toEqual(['load_skill'])
  })

  it('a presenting tool that errors does not spend the budget', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'fail']), calls(['c2', 'show_items']), text('Ok.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'fail', true), tool(tools.url, 'show_items', true)] as never,
        limits: { max_presentations: 1 } as never,
      }),
    )

    expect(result.tool_calls.map((t) => t.status)).toEqual(['error', 'ok'])
    expect(result.presentations).toEqual([{ kind: 'tool', name: 'show_items', call_id: 'c2' }])
  })

  it('a tool presented, then a presenting fence in the answer → the block is cut, suppressed, text kept', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'show_items']), text(`See the list.\n\n${card(['82'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'show_items', true)] as never,
        limits: { max_presentations: 1 } as never,
        output_checks: [{ fence: 'card', schema: CARD_SCHEMA, presents: true }],
      } as never),
    )

    expect(assistantText(result)).toBe('See the list.')
    expect(result.output_checks).toEqual([
      { fence: 'card', status: 'suppressed', attempts: 0, reason: 'presentation_limit' },
    ])
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('a presenting fence that passes is counted', async () => {
    const model = mockModel([text(`Apply this.\n\n${card(['1'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        limits: { max_presentations: 1 } as never,
        output_checks: [{ fence: 'card', schema: CARD_SCHEMA, presents: true }],
      } as never),
    )

    expect(result.presentations).toEqual([{ kind: 'fence', name: 'card' }])
  })

  it('without max_presentations, presents has no effect', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'show_items'], ['c2', 'show_more']), text(`Ok.\n\n${card(['1'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'show_items', true), tool(tools.url, 'show_more', true)] as never,
        output_checks: [{ fence: 'card', schema: CARD_SCHEMA, presents: true }],
      } as never),
    )

    expect(tools.requests).toHaveLength(2)
    expect(result.output_checks![0]!.status).toBe('passed')
    expect('presentations' in result).toBe(false)
  })
})

describe('part B: blocks belong to the final answer (SPEC §5.4)', () => {
  it('interim: drop → the block leaves the stored message and the next prompt; the journal keeps it', async () => {
    const tools = await toolServer()
    const model = mockModel([withCalls(`Checking.\n\n${card(['91'])}`, ['c1', 'lookup']), text(`Fixed.\n\n${card(['82'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'lookup')] as never,
        output_checks: [{ fence: 'card', schema: CARD_SCHEMA, interim: 'drop' }],
      } as never),
    )

    expect(assistantText(result, 0)).toBe('Checking.')
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain('91')
    expect(assistantText(result)).toContain('"82"')
    const entries = await logs(engine, result.run_id, 'interim_block_dropped')
    expect(entries[0]).toMatchObject({ fence: 'card', step: 1, blocks: 1 })
    expect((entries[0]!.content as { text: string }).text).toContain('91')
  })

  it('an interim step with only a block keeps just the tool call; an unclosed block is dropped to the end', async () => {
    const tools = await toolServer()
    const model = mockModel([
      withCalls(card(['1']), ['c1', 'lookup']),
      withCalls('Almost.\n```card\n{"codes": [', ['c2', 'lookup', { q: 'z' }]),
      text('Done.'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'lookup')] as never,
        output_checks: [{ fence: 'card', schema: CARD_SCHEMA, interim: 'drop' }],
      } as never),
    )

    const assistants = result.messages.filter((m) => m.role === 'assistant') as Array<{ content: Array<{ type: string }> }>
    expect(assistants[0]!.content.map((p) => p.type)).toEqual(['tool_call'])
    expect(assistantText(result, 1)).toBe('Almost.')
  })

  it('interim: keep (default) → v1: the block stays in the tool step', async () => {
    const tools = await toolServer()
    const model = mockModel([withCalls(`Checking.\n\n${card(['91'])}`, ['c1', 'lookup']), text('Done.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [tool(tools.url, 'lookup')] as never, output_checks: [{ fence: 'card', schema: CARD_SCHEMA }] } as never),
    )

    expect(assistantText(result, 0)).toContain('91')
  })
})

describe('part C: max_repeated_calls (SPEC §6.7)', () => {
  it('0 → the first repeat disables tools, the run completes with text', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'lookup']), calls(['c2', 'lookup', { q: 'c1' }]), text('Answer.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [tool(tools.url, 'lookup')] as never, limits: { max_repeated_calls: 0 } as never }),
    )

    expect(model.doStreamCalls[2]!.toolChoice).toEqual({ type: 'none' })
    expect(result.status).toBe('completed')
    const entries = await logs(engine, result.run_id, 'tools_disabled')
    expect(entries[0]).toMatchObject({ reason: 'repeated_calls', max_repeated_calls: 0 })
  })

  it('values above 3 are clamped', async () => {
    const model = mockModel([text('Hi.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const result = await runWait(engine, runRequest({ limits: { max_repeated_calls: 10 } as never }))
    const entries = await logs(engine, result.run_id, 'run_start')
    expect((entries[0]!.limits as { max_repeated_calls: number }).max_repeated_calls).toBe(3)
  })
})

describe('part D: grounded values (SPEC §5.4)', () => {
  const grounded = (path = '/codes/*') => [
    { fence: 'card', schema: CARD_SCHEMA, grounded: [{ path, tools: ['lookup'] }] },
  ]

  it('values found in the tool results pass; numbers compare as strings', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'lookup']), text(`Ok.\n\n${card(['82', 7, 'North'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [tool(tools.url, 'lookup')] as never, output_checks: grounded() } as never),
    )

    expect(result.output_checks![0]!.status).toBe('passed')
  })

  it('a value from the request history counts', async () => {
    const model = mockModel([text(`Ok.\n\n${card(['55'])}`)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'find' }], created_at: '2026-10-28T10:00:00Z' },
      { role: 'assistant', content: [{ type: 'tool_call', call_id: 'h1', tool: 'lookup', args: {} }] },
      { role: 'tool', call_id: 'h1', tool: 'lookup', result: { codes: ['55'] }, is_error: false },
      { role: 'user', content: [{ type: 'text', text: 'apply' }], created_at: '2026-10-28T10:01:00Z' },
    ]

    const result = await runWait(engine, runRequest({ messages: history, output_checks: grounded() } as never))

    expect(result.output_checks![0]!.status).toBe('passed')
  })

  it('an invented value → repair with the ungrounded line; fixed → repaired', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'lookup']), text(`Ok.\n\n${card(['91'])}`), text(card(['82']))])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [tool(tools.url, 'lookup')] as never, output_checks: grounded() } as never),
    )

    expect(result.output_checks![0]).toMatchObject({
      status: 'repaired',
      attempts: 1,
      errors: ['/codes/0: "91" is not among the values returned by lookup'],
    })
    expect(assistantText(result)).toContain('"82"')
    const entries = await logs(engine, result.run_id, 'output_check')
    expect(entries[0]).toMatchObject({ attempt: 0, outcome: 'ungrounded', errors: ['/codes/0'] })
  })

  it('not fixed → failed, the block is cut', async () => {
    const tools = await toolServer()
    const model = mockModel([calls(['c1', 'lookup']), text(`Ok.\n\n${card(['91'])}`), text(card(['92']))])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [tool(tools.url, 'lookup')] as never, output_checks: grounded() } as never),
    )

    expect(result.output_checks![0]).toMatchObject({ status: 'failed', reason: 'repairs_exhausted' })
    expect(assistantText(result)).toBe('Ok.')
  })

  it('* over object keys; a path that matches nothing passes', async () => {
    const tools = await toolServer()
    const schema = { type: 'object' }
    const model = mockModel([calls(['c1', 'lookup']), text('Ok.\n\n```card\n{"map": {"a": "82", "b": "North"}}\n```')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({
        tools: [tool(tools.url, 'lookup')] as never,
        output_checks: [
          { fence: 'card', schema, grounded: [{ path: '/map/*', tools: ['lookup'] }, { path: '/none/*', tools: ['lookup'] }] },
        ],
      } as never),
    )

    expect(result.output_checks![0]!.status).toBe('passed')
  })
})
