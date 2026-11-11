/**
 * Content-free logging (SPEC §12.5): with LOG_CONTENT=none, or `logging.content: "none"` in
 * the request, a canary placed in every kind of content must not reach any sink — stdout
 * (with LOG_PROMPTS=1 and the access log), the memory journal, the disk journal, the error
 * webhook — and no event may emit a field the registry does not know.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import { flushJournal, setStdoutSink } from '../src/log.js'
import { onRegistryMiss } from '../src/log-policy.js'
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
  waitFor,
  type LocalServer,
} from './helpers.js'

const C = 'ZQXCANARY7'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

interface Sinks {
  stdout: string[]
  misses: string[]
  dir: string
  hook: LocalServer
}

async function sinks(): Promise<Sinks> {
  const stdout: string[] = []
  const misses: string[] = []
  setStdoutSink(
    new Writable({
      write(chunk, _enc, cb) {
        stdout.push(String(chunk))
        cb()
      },
    }) as never,
  )
  onRegistryMiss((where) => misses.push(where))
  const dir = mkdtempSync(join(tmpdir(), 'theloop-canary-'))
  const hook = await startServer((_b, _r, res) => json(res, 200, { ok: true }))
  cleanup.push(() => {
    setStdoutSink(null)
    onRegistryMiss(null)
    rmSync(dir, { recursive: true, force: true })
  })
  cleanup.push(() => hook.close())
  return { stdout, misses, dir, hook }
}

function engineWith(s: Sinks, model: ReturnType<typeof mockModel>, env: Record<string, string>): Engine {
  const engine = createEngine(
    testConfig({
      LOG_LEVEL: 'debug',
      LOG_PROMPTS: '1',
      LOG_DIR: s.dir,
      ERROR_WEBHOOK_URL: `${s.hook.url}/alerts`,
      ...env,
    }),
    { modelFactory: mockFactory(model) },
  )
  cleanup.push(() => engine.shutdown())
  return engine
}

async function everything(engine: Engine, s: Sinks): Promise<string> {
  // shutdown cuts the callback backoff short: the last attempt fails → callback_failed + webhook
  await engine.shutdown()
  await waitFor(() => s.hook.requests.some((r) => (r.body as { event?: string })?.event === 'callback_failed'), 10_000, 20)
  flushJournal()
  const logs = await engine.app.request('/logs?limit=10000', { headers: bearer() })
  const memory = await logs.text()
  const disk = readdirSync(s.dir)
    .map((f) => readFileSync(join(s.dir, f), 'utf8'))
    .join('\n')
  return [memory, disk, s.stdout.join(''), JSON.stringify(s.hook.requests)].join('\n')
}

/** A request with the canary in every place a request can carry content. */
function canaryRequest(toolUrl: string, callbackUrl: string, logging?: unknown): Record<string, unknown> {
  return runRequest({
    system: `You are an assistant. ${C}-system`,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `${C}-user` }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `${C}-assistant` },
          { type: 'tool_call', call_id: `${C}-hcall`, tool: 'getStatus', args: { q: `${C}-hargs` } },
        ],
      },
      { role: 'tool', call_id: `${C}-hcall`, tool: 'getStatus', result: { r: `${C}-hresult` }, is_error: false },
      { role: 'user', content: [{ type: 'text', text: `${C}-user2` }] },
    ] as never,
    meta: { session_id: 'sess-1', user_note: `${C}-meta` } as never,
    tools: [
      {
        name: 'getStatus',
        description: 'status',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        endpoint: `${toolUrl}/${C}-path/status`,
        effect: 'read',
      },
    ] as never,
    callback: { url: `${callbackUrl}/cb/${C}-cbpath` } as never,
    wait: true,
    ...(logging ? { logging } : {}),
  } as never)
}

async function scenario(env: Record<string, string>, logging?: unknown): Promise<{ dump: string; misses: string[] }> {
  const s = await sinks()
  let toolHits = 0
  const tools = await startServer((_body, _req, res) => {
    toolHits++
    if (toolHits === 1) return json(res, 200, { status: 'ok', result: { found: `${C}-toolresult` } })
    return json(res, 500, { oops: `${C}-toolbody` })
  })
  cleanup.push(() => tools.close())
  const callback = await startServer((_b, _r, res) => json(res, 400, { echoed: `${C}-cbresponse` }))
  cleanup.push(() => callback.close())

  const model = mockModel([
    streamFrom([
      START,
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: `${C}-reasoning` },
      { type: 'reasoning-end', id: 'r1' },
      ...textChunks(`${C}-steptext`),
      toolCall(`${C}-call1`, 'getStatus', { q: `${C}-args1` }),
      finish('tool-calls'),
    ]),
    streamFrom([
      START,
      toolCall(`${C}-call2`, `${C}_inventedTool`, { q: `${C}-args2` }),
      toolCall(`${C}-call3`, 'getStatus', { q: `${C}-args3` }),
      finish('tool-calls'),
    ]),
    streamFrom([START, ...textChunks(`${C}-answer`), finish('stop')]),
  ])
  const engine = engineWith(s, model, env)
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify(canaryRequest(tools.url, callback.url, logging)),
  })
  const result = (await res.json()) as { status: string; run_id: string; messages: unknown[] }
  if (!result.status) console.log(JSON.stringify(result))
  expect(result.status).toBe('completed')
  // the request path is the contract and keeps content (SPEC §12.5)
  expect(JSON.stringify(result.messages)).toContain(`${C}-answer`)

  // a refusal: invalid body with the canary, and an unknown async tool result
  await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...canaryRequest(tools.url, callback.url, logging), limits: { max_steps: `${C}-bad` } }),
  })
  await engine.app.request(`/runs/${result.run_id}/tool-result`, {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ call_id: `${C}-unknowncall`, result: `${C}-asyncresult` }),
  })
  return { dump: await everything(engine, s), misses: s.misses }
}

describe('content-free logging: canary (SPEC §12.5)', () => {
  it('LOG_CONTENT=none: the canary reaches no sink, no unregistered field', async () => {
    const { dump, misses } = await scenario({ LOG_CONTENT: 'none' })
    expect(dump).toContain('run_start')
    expect(dump).toContain('callback_failed')
    expect(dump).toContain('tool_call_rejected')
    expect(dump).not.toContain(C)
    expect(misses).toEqual([])
  }, 30_000)
})

async function failingScenario(env: Record<string, string>, logging?: unknown): Promise<{ dump: string; misses: string[] }> {
  const s = await sinks()
  const model = mockModel(async () => {
    // a provider error whose message quotes the prompt, and a message that forges a stack frame
    throw Object.assign(new Error(`upstream said: ${C}-providermsg\n    at ${C}frame (/app/dist/runs/runner.js:1:1)`), {
      statusCode: 400,
      responseBody: `{"error":"${C}-providerbody"}`,
    })
  })
  const engine = engineWith(s, model, env)
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({
      ...runRequest({
        system: `${C}-system`,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${C}-user` }] }] as never,
        meta: { note: `${C}-meta` } as never,
      }),
      ...(logging ? { logging } : {}),
    }),
  })
  const result = (await res.json()) as { status: string }
  expect(result.status).toBe('failed')
  await waitFor(() => s.hook.requests.some((r) => (r.body as { event?: string })?.event === 'run_failed'), 5000, 20)
  await engine.shutdown()
  flushJournal()
  const memory = await (await engine.app.request('/logs?limit=10000', { headers: bearer() })).text()
  const disk = readdirSync(s.dir)
    .map((f) => readFileSync(join(s.dir, f), 'utf8'))
    .join('\n')
  return { dump: [memory, disk, s.stdout.join(''), JSON.stringify(s.hook.requests)].join('\n'), misses: s.misses }
}

describe('content-free logging: failures (SPEC §12.5)', () => {
  it('LOG_CONTENT=none: provider error text and body stay out of every sink', async () => {
    const { dump, misses } = await failingScenario({ LOG_CONTENT: 'none' })
    expect(dump).toContain('provider_failure')
    expect(dump).toContain('run_failed')
    expect(dump).not.toContain(C)
    expect(misses).toEqual([])
  })

  it('logging.content: "none" on a LOG_CONTENT=all engine', async () => {
    const { dump, misses } = await failingScenario({}, { content: 'none' })
    expect(dump).toContain('provider_failure')
    expect(dump).not.toContain(C)
    expect(misses).toEqual([])
  })

  it('LOG_CONTENT=all keeps today\'s content', async () => {
    const { dump } = await failingScenario({})
    expect(dump).toContain(`${C}-system`)
    expect(dump).toContain(`${C}-providermsg`)
  })
})

describe('content-free logging: request ceiling (SPEC §12.5)', () => {
  it('logging.content: "none" on a LOG_CONTENT=all engine: the full run', async () => {
    const { dump, misses } = await scenario({}, { content: 'none' })
    expect(dump).toContain('run_start')
    expect(dump).not.toContain(C)
    expect(misses).toEqual([])
  }, 30_000)

  it('a class list keeps exactly its classes', async () => {
    const { dump, misses } = await scenario({ LOG_CONTENT: 'tools,meta' })
    expect(dump).toContain(`${C}-toolresult`)
    expect(dump).toContain(`${C}-args1`)
    expect(dump).toContain(`${C}-meta`)
    expect(dump).not.toContain(`${C}-system`)
    expect(dump).not.toContain(`${C}-answer`)
    expect(dump).not.toContain(`${C}-steptext`)
    expect(dump).not.toContain(`${C}-cbresponse`)
    expect(dump).not.toContain(`${C}-cbpath`)
    expect(dump).not.toContain(`${C}_inventedTool`)
    expect(misses).toEqual([])
  }, 30_000)

  it('an invalid logging field: the refusal is logged as none', async () => {
    const s = await sinks()
    const engine = engineWith(s, mockModel([]), {})
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ ...runRequest({ system: `${C}-system` }), logging: { content: ['bogus'] }, limits: { max_steps: `${C}` } }),
    })
    expect(res.status).toBe(400)
    const memory = await (await engine.app.request('/logs', { headers: bearer() })).text()
    expect(memory).toContain('run_rejected')
    expect(memory).not.toContain(C)
  })
})
