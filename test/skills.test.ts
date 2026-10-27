/**
 * Skills and deferred tools on the mock model (SPEC §6.8, RFC 0001): load_skill, activation
 * from the next step, tool_not_loaded, restoration from history, both activation
 * mechanisms, trimming pins and the additive contract.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult, StoredMessage } from '../src/contracts.js'
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
  const server = await startServer((body, _req, res) =>
    json(res, 200, { status: 'ok', result: { tool: (body as { tool: string }).tool } }),
  )
  cleanup.push(() => server.close())
  return server
}

async function post(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  return engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify({ ...body, wait: true }) })
}

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await post(engine, body)
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

async function journal(engine: Engine, runId: string): Promise<LogEntry[]> {
  const res = await engine.app.request(`/runs/${runId}/logs`, { headers: bearer() })
  return ((await res.json()) as { entries: LogEntry[] }).entries
}

function tool(url: string, name: string, deferred = false) {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    endpoint: `${url}/${name}`,
    effect: 'read',
    ...(deferred ? { defer_loading: true } : {}),
  }
}

const BODY = '# Returns\n\nCheck the order status first.'

function skillRequest(url: string, overrides: Record<string, unknown> = {}) {
  return runRequest({
    tools: [tool(url, 'getOrder'), tool(url, 'createReturn', true), tool(url, 'getReturnStatus', true)] as never,
    skills: [
      {
        name: 'order-returns',
        description: 'Return and refund policy. Use when the user asks about a return.',
        body: BODY,
        tools: ['createReturn', 'getReturnStatus'],
      },
      { name: 'shipping', description: 'Shipping rates.', body: '# Shipping' },
    ] as never,
    ...overrides,
  })
}

const HEADER = '[engine] Skill "order-returns" loaded. Tools available from the next step: createReturn, getReturnStatus.'

type Model = ReturnType<typeof mockModel>

const toolNames = (model: Model, step: number) => (model.doStreamCalls[step]!.tools ?? []).map((t) => t.name)

function toolOutputs(model: Model, step: number): any[] {
  return model.doStreamCalls[step]!.prompt
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as Array<{ output: unknown }>)
    .map((p) => p.output)
}

function systemText(model: Model, step: number): string {
  return model.doStreamCalls[step]!.prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
}

/** A history where an earlier run loaded the skill. */
function loadedHistory(): StoredMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'I want to return my order' }] },
    { role: 'assistant', content: [{ type: 'tool_call', call_id: 'h1', tool: 'load_skill', args: { name: 'order-returns' } }] },
    { role: 'tool', call_id: 'h1', tool: 'load_skill', builtin: true, is_error: false, result: BODY },
    { role: 'assistant', content: [{ type: 'text', text: 'Which order?' }] },
    { role: 'user', content: [{ type: 'text', text: 'Order 42' }] },
  ]
}

describe('skills: load_skill (SPEC §6.8)', () => {
  it('the skill index is appended to system, sorted by name', async () => {
    const tools = await toolServer()
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    await runWait(engine, skillRequest(tools.url))

    expect(systemText(model, 0)).toBe(
      'You are an assistant.\n\n' +
        '[engine] Skills. Before working on a topic a skill covers, call load_skill with its name: ' +
        'the instructions, and the tools the skill unlocks, arrive on the next step.\n' +
        '- order-returns: Return and refund policy. Use when the user asks about a return.\n' +
        '- shipping: Shipping rates.',
    )
  })

  it('load_skill returns header and body; the tools arrive on the next step; max_tool_calls is untouched', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'order-returns' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'createReturn', { id: '42' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Return opened'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url, { limits: { max_tool_calls: 1 } }))

    expect(result.status).toBe('completed')
    expect(toolNames(model, 0)).toEqual(['getOrder', 'load_skill'])
    expect(toolNames(model, 1)).toEqual(['createReturn', 'getOrder', 'getReturnStatus', 'load_skill'])
    expect(toolOutputs(model, 1)[0]).toEqual({ type: 'text', value: `${HEADER}\n\n${BODY}` })

    expect(result.messages[1]).toMatchObject({ role: 'tool', tool: 'load_skill', builtin: true, result: BODY })
    expect(result.messages[3]).not.toHaveProperty('builtin')
    expect(result.tool_calls[0]).toMatchObject({ call_id: 'c1', tool: 'load_skill', builtin: true, effect: 'read', status: 'ok' })
    expect(result.tool_calls[1]).not.toHaveProperty('builtin')
    expect(tools.requests.map((r) => r.path)).toEqual(['/createReturn'])

    const loaded = (await journal(engine, result.run_id)).find((e) => e.event === 'skill_loaded')
    expect(loaded).toMatchObject({ name: 'order-returns', tools: ['createReturn', 'getReturnStatus'], reloaded: false })
  })

  it('a hidden tool is tool_not_loaded; in the same batch as load_skill it runs on the next step, not as a repeat', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([
        START,
        toolCall('c1', 'load_skill', { name: 'order-returns' }),
        toolCall('c2', 'createReturn', { id: '42' }),
        finish('tool-calls'),
      ]),
      streamFrom([START, toolCall('c3', 'createReturn', { id: '42' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url))

    const rejected = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c2') as Record<string, any>
    expect(rejected.is_error).toBe(true)
    expect(rejected.error).toBe('tool_not_loaded: createReturn belongs to skill "order-returns". Call load_skill("order-returns") first.')
    const executed = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c3') as Record<string, any>
    expect(executed).toMatchObject({ is_error: false, result: { tool: 'createReturn' } })
    expect(tools.requests).toHaveLength(1)

    const events = await journal(engine, result.run_id)
    expect(events.find((e) => e.event === 'tool_call_rejected')).toMatchObject({ reason: 'tool_not_loaded', tool: 'createReturn' })
    expect(events.some((e) => e.event === 'tool_call_repeated')).toBe(false)
  })

  it('an unknown skill is a tool error and the run continues; the name stays out of metadata', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'order-refunds' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('Sorry'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url))

    expect(result.status).toBe('completed')
    expect(result.messages[1]).toMatchObject({
      builtin: true,
      is_error: true,
      error: 'unknown_skill: order-refunds. Available skills: order-returns, shipping.',
    })
    expect(result.tool_calls[0]).toMatchObject({ status: 'error', builtin: true })
    const unknown = (await journal(engine, result.run_id)).find((e) => e.event === 'skill_unknown')!
    expect(unknown.content).toEqual({ name: 'order-refunds' })
    expect(JSON.stringify({ ...unknown, content: undefined })).not.toContain('order-refunds')
  })

  it('the same skill twice in a run is repeated_call', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'shipping' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'load_skill', { name: 'shipping' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url))

    const second = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c2') as Record<string, any>
    expect(second.is_error).toBe(true)
    expect(second.error).toMatch(/^repeated_call:/)
  })

  it('a load on the last allowed step is not executed (§10.1)', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'shipping' }), finish('tool-calls')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url, { limits: { max_steps: 1 } }))

    expect(result.status).toBe('stopped_limit')
    expect(result.finish_reason).toBe('max_steps')
    expect(result.messages[1]).toMatchObject({ is_error: true, error: 'not_executed: max_steps' })
    expect(result.tool_calls[0]).toMatchObject({ status: 'not_executed', builtin: true })
  })

  it('repeats disable the built-ins together with the rest (tool_choice none)', async () => {
    const tools = await toolServer()
    const call = (id: string) => streamFrom([START, toolCall(id, 'load_skill', { name: 'shipping' }), finish('tool-calls')])
    const model = mockModel([call('c1'), call('c2'), call('c3'), streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url))

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls[3]!.toolChoice).toEqual({ type: 'none' })
  })
})

describe('skills: restoration from history (SPEC §6.8)', () => {
  it('a skill loaded in an earlier run is visible on step 1; a reload returns the body', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'order-returns' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, skillRequest(tools.url, { messages: loadedHistory() }))

    expect(toolNames(model, 0)).toEqual(['createReturn', 'getOrder', 'getReturnStatus', 'load_skill'])
    // the historical result renders exactly as the live one
    expect(toolOutputs(model, 0)[0]).toEqual({ type: 'text', value: `${HEADER}\n\n${BODY}` })
    expect(result.messages[1]).toMatchObject({ is_error: false, result: BODY })

    const events = await journal(engine, result.run_id)
    expect(events.find((e) => e.event === 'skills_restored')).toMatchObject({
      skills: ['order-returns'],
      tools: ['createReturn', 'getReturnStatus'],
    })
    expect(events.find((e) => e.event === 'skill_loaded')).toMatchObject({ reloaded: true })
  })

  it('a skill gone from skills[] activates nothing and is not an error', async () => {
    const tools = await toolServer()
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const request = skillRequest(tools.url, { messages: loadedHistory() })
    ;(request.skills as Array<{ name: string }>).shift()
    ;(request.tools as Array<{ name: string }>).splice(1, 2)

    const result = await runWait(engine, request)

    expect(result.status).toBe('completed')
    expect(toolNames(model, 0)).toEqual(['getOrder', 'load_skill'])
  })

  it('an HTTP load_skill pair without builtin: true activates nothing and renders as today', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'createReturn', { id: '42' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const history = loadedHistory()
    delete (history[2] as { builtin?: true }).builtin

    const result = await runWait(engine, skillRequest(tools.url, { messages: history }))

    expect(toolNames(model, 0)).toEqual(['getOrder', 'load_skill'])
    expect(toolOutputs(model, 0)[0]).toEqual({ type: 'text', value: BODY })
    expect(result.messages[1]).toMatchObject({ is_error: true, error: expect.stringMatching(/^tool_not_loaded:/) })
  })

  it('a marked pair with a corrupt result is ordinary history with builtin_history_invalid', async () => {
    const tools = await toolServer()
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const history = loadedHistory()
    ;(history[2] as { result: unknown }).result = { not: 'a body' }

    const result = await runWait(engine, skillRequest(tools.url, { messages: history }))

    expect(toolNames(model, 0)).toEqual(['getOrder', 'load_skill'])
    expect(toolOutputs(model, 0)[0]).toEqual({ type: 'json', value: { not: 'a body' } })
    const invalid = (await journal(engine, result.run_id)).find((e) => e.event === 'builtin_history_invalid')
    expect(invalid).toMatchObject({ level: 'warn', call_id: 'h1', tool: 'load_skill' })
  })
})

describe('skills: tool_reference mechanism (SPEC §6.8)', () => {
  it('every step carries every tool, deferred ones with deferLoading; activation goes through tool_reference', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { name: 'order-returns' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(
      createEngine(testConfig(), {
        modelFactory: mockFactory(model, { toolReferences: true, supportsCacheControl: true }),
      }),
    )

    const result = await runWait(engine, skillRequest(tools.url))

    expect(result.status).toBe('completed')
    for (const step of [0, 1]) {
      const sent = model.doStreamCalls[step]!.tools!
      expect(sent.map((t) => t.name)).toEqual(['getOrder', 'load_skill', 'createReturn', 'getReturnStatus'])
      const options = sent.map((t) => (t as { providerOptions?: any }).providerOptions?.anthropic ?? {})
      expect(options).toEqual([
        {},
        { cacheControl: { type: 'ephemeral' } },
        { deferLoading: true },
        { deferLoading: true },
      ])
    }
    const output = toolOutputs(model, 1)[0]
    expect(output.type).toBe('content')
    expect(output.value).toEqual([
      { type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName: 'createReturn' } } },
      { type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName: 'getReturnStatus' } } },
      { type: 'text', text: `${HEADER}\n\n${BODY}` },
    ])
    const start = (await journal(engine, result.run_id)).find((e) => e.event === 'run_start')
    expect(start).toMatchObject({ activation: 'tool_reference', skills: ['order-returns', 'shipping'], tool_search: false })
    expect(start!.tools).toContain('createReturn:read:deferred')
  })

  it('a tool_choice none step still carries the tools', async () => {
    const tools = await toolServer()
    const call = (id: string) => streamFrom([START, toolCall(id, 'load_skill', { name: 'shipping' }), finish('tool-calls')])
    const model = mockModel([call('c1'), call('c2'), call('c3'), streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model, { toolReferences: true }) }))

    await runWait(engine, skillRequest(tools.url))

    expect(model.doStreamCalls[3]!.toolChoice).toEqual({ type: 'none' })
    expect(toolNames(model, 3)).toHaveLength(4)
  })
})

describe('skills: trimming keeps activations (SPEC §5.1, §6.8)', () => {
  it('the block that loaded a skill is pinned; older blocks are dropped instead', async () => {
    const tools = await toolServer()
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model, { contextWindow: 4_000 }) }))
    const filler = 'x'.repeat(20_000)
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      { role: 'assistant', content: [{ type: 'tool_call', call_id: 'h0', tool: 'getOrder', args: { id: '1' } }] },
      { role: 'tool', call_id: 'h0', tool: 'getOrder', is_error: false, result: filler },
      ...loadedHistory().slice(1, 3),
      { role: 'assistant', content: [{ type: 'tool_call', call_id: 'h2', tool: 'getOrder', args: { id: '2' } }] },
      { role: 'tool', call_id: 'h2', tool: 'getOrder', is_error: false, result: filler },
      { role: 'assistant', content: [{ type: 'text', text: 'Which order?' }] },
      { role: 'user', content: [{ type: 'text', text: 'Order 42' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ]

    const result = await runWait(engine, skillRequest(tools.url, { messages: history, limits: { max_tokens: 1000 } }))

    expect(result.context_trimmed).toBe(true)
    const ids = model.doStreamCalls[0]!.prompt
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ toolCallId: string }>)
      .map((p) => p.toolCallId)
    expect(ids).toEqual(['h1'])
    expect(toolNames(model, 0)).toContain('createReturn')
  })
})

describe('skills: the contract stays additive (SPEC §4.2)', () => {
  it('without skills an HTTP tool named load_skill is an ordinary tool', async () => {
    const tools = await toolServer()
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'load_skill', { id: 'x' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('ok'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [tool(tools.url, 'load_skill')] as never }))

    expect(tools.requests.map((r) => r.path)).toEqual(['/load_skill'])
    expect(result.messages[1]).not.toHaveProperty('builtin')
    expect(result.tool_calls[0]).not.toHaveProperty('builtin')
  })

  it.each([
    [
      'a reserved name with the feature on',
      (url: string) => skillRequest(url, { tools: [tool(url, 'load_skill'), tool(url, 'createReturn', true), tool(url, 'getReturnStatus', true)] }),
      'tools[0].name "load_skill" is reserved when skills or deferred tools are used',
    ],
    [
      'an unknown tool in a skill',
      (url: string) => skillRequest(url, { tools: [tool(url, 'getOrder'), tool(url, 'createReturn', true)] }),
      'skills[0].tools: unknown tool "getReturnStatus"',
    ],
    [
      'a deferred tool outside every skill',
      (url: string) => runRequest({ tools: [tool(url, 'getOrder'), tool(url, 'exportReport', true)] as never }),
      'tools[1] "exportReport" is deferred but listed in no skill',
    ],
    [
      'a duplicated skill name',
      (url: string) =>
        runRequest({
          skills: [
            { name: 'a', description: 'a', body: 'a' },
            { name: 'a', description: 'b', body: 'b' },
          ] as never,
        }),
      'skills[1].name "a" is duplicated',
    ],
  ])('400 for %s', async (_label, build, message) => {
    const tools = await toolServer()
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(mockModel([])) }))
    const res = await post(engine, build(tools.url))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message)
  })

  it('400 for a skill name outside the pattern', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(mockModel([])) }))
    const res = await post(engine, runRequest({ skills: [{ name: 'Bad Name', description: 'x', body: 'x' }] as never }))
    expect(res.status).toBe(400)
  })
})
