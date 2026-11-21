/**
 * The run inbox: messages added to a running run (SPEC §4.11).
 * Barriers (gated model calls and tool handlers) fix the interleaving: no timing races.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
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

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

interface Step {
  parts: LanguageModelV3StreamPart[]
  /** The model call waits for this before it answers. */
  wait?: Promise<void>
}

/** A model that answers steps in order and records every prompt; `called(n)` resolves on call n. */
function scriptedModel(steps: Step[]) {
  const prompts: unknown[][] = []
  const waiters = new Map<number, () => void>()
  const model = mockModel(async ({ prompt }) => {
    prompts.push(prompt as unknown[])
    waiters.get(prompts.length)?.()
    const step = steps[prompts.length - 1]
    if (!step) throw new Error(`no step ${prompts.length}`)
    if (step.wait) await step.wait
    return streamFrom(step.parts)
  })
  const called = (n: number) =>
    prompts.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.set(n, resolve))
  return { model, prompts, called }
}

async function start(engine: Engine, body: Record<string, unknown>): Promise<{ run_id: string; cancel_url: string }> {
  const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...body, wait: false, callback: { url: `${callbacks.url}/cb` } }),
  })
  expect(res.status).toBe(202)
  return (await res.json()) as { run_id: string; cancel_url: string }
}

function inject(engine: Engine, runId: string, messages: unknown[], extra: Record<string, unknown> = {}, headers = bearer()) {
  return engine.app.request(`/runs/${runId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contract_version: '1', messages, ...extra }),
  })
}

const userText = (id: string, text: string, created_at?: string) => ({
  role: 'user',
  id,
  ...(created_at ? { created_at } : {}),
  content: [{ type: 'text', text }],
})

async function result(engine: Engine, runId: string): Promise<RunResult> {
  let body: RunResult | null = null
  await waitFor(async () => {
    const res = await engine.app.request(`/runs/${runId}`, { headers: bearer() })
    const json = (await res.json()) as Omit<RunResult, "status"> & { status: string }
    if (json.status === 'running') return false
    body = json as RunResult
    return true
  })
  return body!
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

/** The text of a provider prompt, flattened — enough to see what the model was shown. */
function promptText(prompt: unknown[]): string {
  return JSON.stringify(prompt)
}

describe('run inbox (SPEC §4.11)', () => {
  it('a message during the model call: the answer stands, the run takes one more step for the message', async () => {
    const step1 = gate()
    const { model, prompts, called } = scriptedModel([
      { parts: [START, ...textChunks('first answer'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('second answer'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)

    const res = await inject(engine, run_id, [userText('msg_2', 'also consider Berlin', '2026-11-22T10:15:03Z')])
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: ['msg_2'], run_status: 'running', inbox_pending: 1 })
    step1.open()

    const done = await result(engine, run_id)
    expect(done.status).toBe('completed')
    expect(done.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])
    expect(done.messages[1]).toMatchObject({
      role: 'user',
      id: 'msg_2',
      injected: true,
      seq: 1,
      run_id,
      created_at: '2026-11-22T10:15:03Z',
      content: [{ type: 'text', text: 'also consider Berlin' }],
    })
    expect(done.messages[2]).toMatchObject({ seq: 2 })
    expect(done.pending_messages).toEqual([])
    expect(done.timing.injected).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(promptText(prompts[1]!)).toContain('also consider Berlin')
    expect(promptText(prompts[1]!)).toContain('first answer')
  })

  it('SSE: message_injected comes before the second answer; the snapshot keeps where it fell', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('first'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('second'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)
    step1.open()
    await result(engine, run_id)

    // after the run the stream collapses into snapshot + done (§11.5)
    const res = await engine.app.request(`/runs/${run_id}/stream`, { headers: bearer() })
    const events = parseSse(await readSseUntil(res, (b) => b.includes('event: done')))
    const snapshot = events.find((e) => e.event === 'snapshot')!
    expect(snapshot.data.text).toBe('firstsecond')
    expect(snapshot.data.injected).toEqual([{ id: 'msg_2', seq: 1, text_offset: 'first'.length }])
  })

  it('SSE live: message_injected is emitted between the two answers', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('first'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('second'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)
    const stream = await engine.app.request(`/runs/${run_id}/stream`, { headers: bearer() })
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)
    step1.open()
    const events = parseSse(await readSseUntil(stream, (b) => b.includes('event: done')))
    const names = events.map((e) => (e.event === 'delta' ? `delta:${e.data.text}` : e.event))
    const injectedAt = names.indexOf('message_injected')
    expect(injectedAt).toBeGreaterThan(names.indexOf('delta:first'))
    expect(injectedAt).toBeLessThan(names.indexOf('delta:second'))
    expect(events[injectedAt]!.data).toEqual({ id: 'msg_2', seq: 1 })
  })

  it('a message during a tool batch: seen on the next step, after the tool results; later calls carry its id', async () => {
    const toolGate = gate()
    let toolCalls = 0
    const tools = trackServer(
      await startServer(async (_body, _req, res) => {
        toolCalls++
        if (toolCalls === 1) await toolGate.promise
        json(res, 200, { status: 'ok', result: { n: toolCalls } })
      }),
    )
    const { model, prompts } = scriptedModel([
      { parts: [START, toolCall('c1', 'getStatus', { id: 'a' }), finish('tool-calls')] },
      { parts: [START, toolCall('c2', 'getStatus', { id: 'b' }), finish('tool-calls')] },
      { parts: [START, ...textChunks('done'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest({ idempotency_key: 'msg_1', tools: [readTool(tools.url)] as never }))
    await waitFor(() => toolCalls === 1)

    expect((await inject(engine, run_id, [userText('msg_2', 'check b too')])).status).toBe(202)
    toolGate.open()

    const done = await result(engine, run_id)
    expect(done.status).toBe('completed')
    expect(done.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant', 'tool', 'assistant'])
    expect(done.messages[2]).toMatchObject({ id: 'msg_2', injected: true, seq: 2 })
    expect(promptText(prompts[1]!)).toContain('check b too')
    // §6.4: the call after the message answers that message, not the original request
    expect(tools.requests[0]!.body).toMatchObject({ origin_request_id: 'msg_1' })
    expect(tools.requests[1]!.body).toMatchObject({ origin_request_id: 'msg_2' })
  })

  it('a repeat of the same body is accepted once; the same id with another body is a mismatch', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)

    const message = userText('msg_2', 'more', '2026-11-22T10:15:03Z')
    expect((await inject(engine, run_id, [message])).status).toBe(202)
    const again = await inject(engine, run_id, [message])
    expect(again.status).toBe(202)
    expect(await again.json()).toMatchObject({ accepted: ['msg_2'], inbox_pending: 1 })

    const other = await inject(engine, run_id, [userText('msg_2', 'something else', '2026-11-22T10:15:03Z')])
    expect(other.status).toBe(409)
    expect(((await other.json()) as any).error.code).toBe('inbox_id_mismatch')

    step1.open()
    const done = await result(engine, run_id)
    expect(done.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('after the run finished: 409 run_finished; a repeat of an accepted id names it as known', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)
    const message = userText('msg_2', 'more', '2026-11-22T10:15:03Z')
    expect((await inject(engine, run_id, [message])).status).toBe(202)
    step1.open()
    await result(engine, run_id)

    const late = await inject(engine, run_id, [userText('msg_3', 'late')])
    expect(late.status).toBe(409)
    expect(((await late.json()) as any).error).toMatchObject({ code: 'run_finished' })

    const repeat = await inject(engine, run_id, [message])
    expect(repeat.status).toBe(409)
    expect(((await repeat.json()) as any).error).toMatchObject({ code: 'run_finished', known: ['msg_2'] })
  })

  it('cancel before the next step boundary: the message is pending, not in messages; later ones get run_cancelling', async () => {
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id, cancel_url } = await start(engine, runRequest())
    await waitFor(async () => {
      const res = await engine.app.request(`/runs/${run_id}`, { headers: bearer() })
      return ((await res.json()) as any).steps >= 1
    })
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)

    const token = new URL(cancel_url).searchParams.get('token')!
    const cancelPromise = engine.app.request(`/runs/${run_id}/cancel?token=${token}`, { method: 'POST' })
    const during = await inject(engine, run_id, [userText('msg_3', 'even more')])
    expect([409]).toContain(during.status)
    expect(['run_cancelling', 'run_finished']).toContain(((await during.json()) as any).error.code)

    const cancelled = (await (await cancelPromise).json()) as Record<string, unknown>
    // the browser projection never carries pending_messages: it is history, like messages
    expect(cancelled).not.toHaveProperty('pending_messages')
    expect(cancelled).not.toHaveProperty('messages')

    const done = await result(engine, run_id)
    expect(done.status).toBe('cancelled')
    expect(done.messages.some((m) => m.role === 'user')).toBe(false)
    expect(done.pending_messages).toHaveLength(1)
    expect(done.pending_messages![0]).toMatchObject({ role: 'user', id: 'msg_2', content: [{ type: 'text', text: 'more' }] })
    expect(done.pending_messages![0]!.created_at).toEqual(expect.any(String))
  })

  it('no step left (max_steps): the message is pending', async () => {
    const step1 = gate()
    const { model, called, prompts } = scriptedModel([
      { parts: [START, ...textChunks('only answer'), finish('stop')], wait: step1.promise },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest({ limits: { max_steps: 1 } as never }))
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)
    step1.open()

    const done = await result(engine, run_id)
    expect(done.status).toBe('completed')
    expect(done.messages.map((m) => m.role)).toEqual(['assistant'])
    expect(done.pending_messages!.map((m) => m.id)).toEqual(['msg_2'])
    expect(done.timing.injected).toBe(0)
    expect(prompts).toHaveLength(1)
  })

  it('the final step of a limit takes queued messages before it answers', async () => {
    const step1 = gate()
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: {} })))
    const { model, called, prompts } = scriptedModel([
      { parts: [START, toolCall('c1', 'getStatus', {}), finish('tool-calls')], wait: step1.promise },
      { parts: [START, ...textChunks('final'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(
      engine,
      runRequest({ tools: [readTool(tools.url)] as never, limits: { max_steps: 2 } as never }),
    )
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'and Berlin')])).status).toBe(202)
    step1.open()

    const done = await result(engine, run_id)
    expect(done.status).toBe('completed')
    expect(done.limit_reached).toBe('max_steps')
    expect(done.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant'])
    expect(done.pending_messages).toEqual([])
    expect(promptText(prompts[1]!)).toContain('and Berlin')
  })

  it('awaiting_tool: a message that came during the deferred step is pending', async () => {
    const toolGate = gate()
    let calls = 0
    const tools = trackServer(
      await startServer(async (_body, _req, res) => {
        calls++
        await toolGate.promise
        json(res, 200, { status: 'deferred', operation_id: 'op_1' })
      }),
    )
    const { model } = scriptedModel([{ parts: [START, toolCall('c1', 'createRefund', { id: 'x' }), finish('tool-calls')] }])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(
      engine,
      runRequest({
        idempotency_key: 'msg_1',
        history_revision: 12,
        meta: { session_id: 'sess_1' },
        tools: [readTool(tools.url, 'createRefund', 'write')] as never,
      }),
    )
    await waitFor(() => calls === 1)
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)
    toolGate.open()

    const done = await result(engine, run_id)
    expect(done.status).toBe('awaiting_tool')
    expect(done.pending_messages!.map((m) => m.id)).toEqual(['msg_2'])
    expect((await inject(engine, run_id, [userText('msg_3', 'x')])).status).toBe(409)
  })

  it('history_revision from the inbox is echoed in the result', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest({ history_revision: 12 }))
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'more')], { history_revision: 13 })).status).toBe(202)
    step1.open()
    expect((await result(engine, run_id)).history_revision).toBe(13)
  })

  it('limits: inbox_full by count and by bytes; a body is accepted whole or not at all', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
    ])
    const engine = track(
      createEngine(testConfig({ MAX_INBOX_MESSAGES: '2', MAX_INBOX_BYTES: '400' }), { modelFactory: mockFactory(model) }),
    )
    const { run_id } = await start(engine, runRequest())
    await called(1)

    const three = await inject(engine, run_id, [userText('m1', 'a'), userText('m2', 'b'), userText('m3', 'c')])
    expect(three.status).toBe(413)
    expect(((await three.json()) as any).error.code).toBe('inbox_full')

    const big = await inject(engine, run_id, [userText('m4', 'x'.repeat(500))])
    expect(big.status).toBe(413)

    expect((await inject(engine, run_id, [userText('m1', 'a'), userText('m2', 'b')])).status).toBe(202)
    step1.open()
    const done = await result(engine, run_id)
    expect(done.messages.filter((m) => m.role === 'user').map((m) => (m as { id?: string }).id)).toEqual(['m1', 'm2'])
  })

  it('validation and access: run token is refused, bad bodies are 400, unknown run is 404', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id, cancel_url } = await start(engine, runRequest())
    await called(1)
    const token = new URL(cancel_url).searchParams.get('token')!

    const byBrowser = await inject(engine, run_id, [userText('m1', 'a')], {}, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
    expect(byBrowser.status).toBe(401)

    const dupIds = await inject(engine, run_id, [userText('m1', 'a'), userText('m1', 'b')])
    expect(dupIds.status).toBe(400)
    const noId = await inject(engine, run_id, [{ role: 'user', content: [{ type: 'text', text: 'a' }] }])
    expect(noId.status).toBe(400)
    const assistant = await inject(engine, run_id, [{ role: 'assistant', id: 'x', content: [{ type: 'text', text: 'a' }] }])
    expect(assistant.status).toBe(400)
    const image = await inject(engine, run_id, [{ role: 'user', id: 'x', content: [{ type: 'image', url: 'https://example.com/a.png' }] }])
    expect(image.status).toBe(400)

    expect((await inject(engine, 'run_missing', [userText('m1', 'a')])).status).toBe(404)
    step1.open()
    const done = await result(engine, run_id)
    // nothing accepted: the result looks exactly as before the inbox existed
    expect(done).not.toHaveProperty('pending_messages')
    expect(done.timing).not.toHaveProperty('injected')
  })

  it('event parts are accepted and a missing created_at gets the time of receipt', async () => {
    const step1 = gate()
    const { model, called, prompts } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(engine, runRequest())
    await called(1)
    const before = Date.now()
    const res = await inject(engine, run_id, [
      { role: 'user', id: 'ev_1', content: [{ type: 'event', name: 'background_done', data: { task_id: 't_1' } }] },
    ])
    expect(res.status).toBe(202)
    step1.open()
    const done = await result(engine, run_id)
    const injected = done.messages[1]!
    expect(injected).toMatchObject({ id: 'ev_1', injected: true, content: [{ type: 'event', name: 'background_done' }] })
    expect(new Date(injected.created_at!).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(promptText(prompts[1]!)).toContain('background_done')
  })

  it('output_checks: every answer is checked, the result is the last answer\'s, one entry per fence', async () => {
    const step1 = gate()
    const card = '```card\n{"a":1}\n```'
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks(`here it is\n${card}`), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('noted, nothing else'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const { run_id } = await start(
      engine,
      runRequest({
        output_checks: [{ fence: 'card', schema: { type: 'object', required: ['a'], properties: { a: { type: 'number' } } } }],
      } as never),
    )
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'thanks')])).status).toBe(202)
    step1.open()
    const done = await result(engine, run_id)
    expect(done.status).toBe('completed')
    expect(done.output_checks).toEqual([{ fence: 'card', status: 'absent', attempts: 0 }])
  })

  it('a result with injected messages is valid history for the next run', async () => {
    const step1 = gate()
    const { model, called } = scriptedModel([
      { parts: [START, ...textChunks('a'), finish('stop')], wait: step1.promise },
      { parts: [START, ...textChunks('b'), finish('stop')] },
      { parts: [START, ...textChunks('c'), finish('stop')] },
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const first = runRequest()
    const { run_id } = await start(engine, first)
    await called(1)
    expect((await inject(engine, run_id, [userText('msg_2', 'more')])).status).toBe(202)
    step1.open()
    const done = await result(engine, run_id)

    const next = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(
        runRequest({ messages: [...(first.messages as never[]), ...done.messages, userText('msg_3', 'next')] as never }),
      ),
    })
    expect(next.status).toBe(200)
    expect(((await next.json()) as RunResult).status).toBe('completed')
  })
})
