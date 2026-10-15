/**
 * The event journal and GET /logs, GET /runs/{id}/logs (SPEC §4.9, §12.4): what the loop
 * writes at each step, filters, content and turning it off, no secrets in the journal.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { formatLogText, LogBuffer, type LogEntry } from '../src/log-buffer.js'
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

interface LogsBody {
  entries: LogEntry[]
  truncated: boolean
  next_since: number
  buffer: { entries: number; content: boolean; last_seq: number }
}

async function getLogs(engine: Engine, path: string): Promise<LogsBody> {
  const res = await engine.app.request(path, { headers: bearer() })
  expect(res.status).toBe(200)
  return (await res.json()) as LogsBody
}

function readTool(url: string, name = 'getStatus') {
  return {
    name,
    description: 'test',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    endpoint: `${url}/${name}?sessionID=secret-session`,
    headers: { Authorization: 'Bearer tool-secret-token-123' },
    effect: 'read' as const,
  }
}

async function toolRun(overrides: Record<string, string> = {}) {
  const tools = trackServer(
    await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { state: 'shipped' } })),
  )
  const model = mockModel([
    streamFrom([START, toolCall('c1', 'getStatus', { id: '12345' }), finish('tool-calls')]),
    streamFrom([START, ...textChunks('Order 12345 has shipped'), finish('stop')]),
  ])
  const engine = track(createEngine(testConfig(overrides), { modelFactory: mockFactory(model) }))
  const result = await runWait(
    engine,
    runRequest({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-live-SUPERSECRET-0001' } as never,
      system: 'You are an online store assistant.',
      meta: { session_id: 'sess-1' },
      tools: [readTool(tools.url)] as never,
    }),
  )
  return { engine, result }
}

describe('journal: run timeline', () => {
  it('GET /runs/{id}/logs: from run_start to run_done, with content at every step', async () => {
    const { engine, result } = await toolRun()
    const { entries } = await getLogs(engine, `/runs/${result.run_id}/logs`)
    const events = entries.map((e) => e.event)

    expect(events).toEqual([
      'run_start',
      'step_start',
      'provider_attempt',
      'step_done',
      'tool_call',
      'tool_http',
      'tool_result',
      'step_start',
      'provider_attempt',
      'step_done',
      'run_done',
    ])
    expect(entries.every((e) => e.run_id === result.run_id)).toBe(true)
    // session_id is added to every event of the run, not only to run_start
    expect(entries.every((e) => e.session_id === 'sess-1')).toBe(true)

    const byEvent = (name: string) => entries.filter((e) => e.event === name)
    expect(byEvent('run_start')[0]).toMatchObject({
      model: 'claude-sonnet-5',
      tools: ['getStatus:read'],
      content: { system: 'You are an online store assistant.', history_tail: ['user: hello'] },
    })
    expect(byEvent('step_done')[0]!.content).toMatchObject({
      tool_calls: [{ call_id: 'c1', tool: 'getStatus', args: { id: '12345' } }],
    })
    expect(byEvent('tool_call')[0]).toMatchObject({ call_id: 'c1', content: { args: { id: '12345' } } })
    expect(byEvent('tool_result')[0]).toMatchObject({
      outcome: 'ok',
      content: { result: { state: 'shipped' } },
    })
    expect(byEvent('step_done')[1]!.content).toMatchObject({ text: 'Order 12345 has shipped' })
    expect(byEvent('run_done')[0]).toMatchObject({
      status: 'completed',
      finish_reason: 'end_turn',
      steps: 2,
      content: { answer: 'Order 12345 has shipped' },
    })
  })

  it('keys, tool headers and query parameters stay out of the journal', async () => {
    const { engine } = await toolRun()
    const dump = JSON.stringify(await getLogs(engine, '/logs'))
    expect(dump).not.toContain('SUPERSECRET')
    expect(dump).not.toContain('tool-secret-token')
    expect(dump).not.toContain('secret-session')
    expect(dump).toContain('sessionID=%3Credacted%3E')
  })

  it('LOG_BUFFER_CONTENT=0: metadata only', async () => {
    const { engine, result } = await toolRun({ LOG_BUFFER_CONTENT: '0' })
    const body = await getLogs(engine, `/runs/${result.run_id}/logs`)
    expect(body.buffer.content).toBe(false)
    expect(body.entries.length).toBeGreaterThan(5)
    expect(body.entries.some((e) => e.content)).toBe(false)
    expect(body.entries.find((e) => e.event === 'tool_result')).toMatchObject({ outcome: 'ok' })
  })

  it('LOG_CONTENT_MAX_CHARS clips every content field', async () => {
    const { engine, result } = await toolRun({ LOG_CONTENT_MAX_CHARS: '10' })
    const { entries } = await getLogs(engine, `/runs/${result.run_id}/logs?event=run_start`)
    expect(entries[0]!.content!.system).toBe('You are an…[+24 chars]')
  })

  it('format=text: a readable timeline', async () => {
    const { engine, result } = await toolRun()
    const res = await engine.app.request(`/runs/${result.run_id}/logs?format=text`, { headers: bearer() })
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text.startsWith(`# run_id=${result.run_id} session_id=sess-1\n`)).toBe(true)
    expect(text.split('\n')[1]).toMatch(/^\d\d:\d\d:\d\d\.\d{3}Z\s+\+0ms INFO\s+run_start\s+provider=anthropic/)
    expect(text.split('\n').slice(1).join('\n')).not.toContain('run_id=')
    expect(text).toContain('      system: You are an online store assistant.')
    expect(text).toContain('tool_result')
  })
})

describe('journal: loops and limits', () => {
  it('a repeated call and disabled tools show up in the journal', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { state: 'x' } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c3', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('answer'), finish('stop')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never }))

    const { entries } = await getLogs(engine, `/logs?run_id=${result.run_id}&level=warn`)
    expect(entries.map((e) => e.event)).toEqual(['tool_call_repeated', 'tool_call_repeated', 'tools_disabled'])
    expect(entries[0]).toMatchObject({ call_id: 'c2', content: { args: { id: '1' } } })
    expect(entries[2]).toMatchObject({ reason: 'repeated_calls', repeated_calls: 2 })
  })

  it('limit_hit: max_steps with the numbers, and sealed tool calls', async () => {
    const tools = trackServer(
      await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: { n: 1 } })),
    )
    const model = mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '2' }), finish('tool-calls')]),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }),
    )
    expect(result.finish_reason).toBe('max_steps')

    const { entries } = await getLogs(engine, `/logs?run_id=${result.run_id}&event=limit_hit,tool_calls_sealed`)
    expect(entries[0]).toMatchObject({ limit: 'max_steps', step: 2, max_steps: 2, pending_tool_calls: 1 })
    expect(entries[1]).toMatchObject({ reason: 'not_executed: max_steps', calls: ['getStatus#c2'] })
  })
})

describe('journal: rejections and endpoints', () => {
  it('a rejected POST /runs is logged as run_rejected with the code and session', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(mockModel([])) }))
    await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest({ meta: { session_id: 'sess-x' }, wait: false })),
    })
    await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer('wrong-token'),
      body: JSON.stringify(runRequest()),
    })

    const { entries } = await getLogs(engine, '/logs?event=run_rejected')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      session_id: 'sess-x',
      http_status: 400,
      code: 'bad_request',
      message: 'callback.url or wait: true is required',
      model: 'claude-sonnet-5',
    })
    expect(entries[1]).toMatchObject({ http_status: 401, code: 'unauthorized' })

    const bySession = await getLogs(engine, '/logs?session_id=sess-x')
    expect(bySession.entries.map((e) => e.event)).toEqual(['run_rejected'])
  })

  it('since / next_since: a tail without repeats', async () => {
    const { engine } = await toolRun()
    const first = await getLogs(engine, '/logs?limit=3')
    expect(first.entries).toHaveLength(3)
    expect(first.truncated).toBe(true)
    expect(first.next_since).toBe(first.buffer.last_seq)

    const tail = await getLogs(engine, `/logs?since=${first.next_since}`)
    expect(tail.entries).toHaveLength(0)
    expect(tail.next_since).toBe(first.next_since)

    const page = await getLogs(engine, '/logs?since=0&limit=2')
    expect(page.entries.map((e) => e.seq)).toEqual([1, 2])
    expect(page.next_since).toBe(2)
  })

  it('no ENGINE_TOKEN → 401, unknown run → 404, bad level → 400', async () => {
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(mockModel([])) }))
    expect((await engine.app.request('/logs')).status).toBe(401)
    expect((await engine.app.request('/runs/run_nope/logs', { headers: bearer() })).status).toBe(404)
    expect((await engine.app.request('/logs?level=verbose', { headers: bearer() })).status).toBe(400)
    expect((await engine.app.request('/logs?since=-1', { headers: bearer() })).status).toBe(400)
  })
})

describe('LogBuffer', () => {
  it('evicts old entries in a batch down to 90% of the cap and counts dropped', () => {
    const buffer = new LogBuffer(10, 1_000_000)
    for (let i = 0; i < 11; i++) buffer.push('info', `e${i}`, { run_id: 'r' }, undefined)
    const stats = buffer.stats()
    expect(stats.entries).toBe(9)
    expect(stats.dropped).toBe(2)
    expect(buffer.query({ limit: 100 }).entries[0]!.event).toBe('e2')
  })

  it('a cap in bytes', () => {
    const buffer = new LogBuffer(1000, 2_000)
    for (let i = 0; i < 50; i++) buffer.push('info', 'e', {}, { text: 'x'.repeat(100) })
    expect(buffer.stats().bytes).toBeLessThanOrEqual(2_000)
    expect(buffer.stats().dropped).toBeGreaterThan(0)
  })

  it('the level filter means "at least"', () => {
    const buffer = new LogBuffer(100, 1_000_000)
    buffer.push('debug', 'a', {}, undefined)
    buffer.push('info', 'b', {}, undefined)
    buffer.push('warn', 'c', {}, undefined)
    buffer.push('error', 'd', {}, undefined)
    expect(buffer.query({ minLevel: 'warn', limit: 10 }).entries.map((e) => e.event)).toEqual(['c', 'd'])
  })

  it('formatLogText: multiline content is indented', () => {
    const buffer = new LogBuffer(100, 1_000_000)
    buffer.push('info', 'step_done', { run_id: 'r1', step: 1 }, { text: 'line 1\nline 2' })
    const text = formatLogText(buffer.query({ limit: 10 }).entries)
    expect(text).toContain('INFO  step_done  run_id=r1 step=1\n')
    expect(text).toContain('      text: line 1\n        line 2\n')
  })
})
