/**
 * Live smoke against a local model server (SPEC §9.1, RFC 0004 §5.5): Ollama, vLLM or any
 * OpenAI-compatible server. Not run in CI.
 *
 *   SMOKE_LOCAL_URL=http://localhost:11434/v1 SMOKE_LOCAL_MODEL=qwen3:8b npm run smoke:local
 *
 * Optional: SMOKE_LOCAL_KIND=anthropic, SMOKE_LOCAL_API_KEY, SMOKE_LOCAL_CONTEXT_WINDOW (default 8000),
 * SMOKE_LOCAL_REASONING_REPLAY (none | reasoning | reasoning_content).
 *
 * Checks: a run with a tool call and a second step that uses the result; usage present or
 * estimated; a cancel mid-stream; an oversized history trimmed by the engine (context_trimmed)
 * before the server could cut it.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine } from '../src/app.js'
import { createConfig } from '../src/config.js'
import { logBuffer } from '../src/log.js'

const url = process.env.SMOKE_LOCAL_URL
const model = process.env.SMOKE_LOCAL_MODEL
if (!url || !model) {
  console.error('set SMOKE_LOCAL_URL (…/v1) and SMOKE_LOCAL_MODEL')
  process.exit(2)
}
const target = new URL(url)
const contextWindow = Number(process.env.SMOKE_LOCAL_CONTEXT_WINDOW ?? 8000)

const tools = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', result: { sku: 'A-17', in_stock: 42, warehouse: 'north' } }))
  })
})
await new Promise<void>((r) => tools.listen(0, '127.0.0.1', r))
const toolPort = (tools.address() as AddressInfo).port

const engine = createEngine(
  createConfig({
    PORT: '0',
    ENGINE_TOKEN: 'smoke',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    LLM_ENDPOINT_SMOKE_URL: url,
    LLM_ENDPOINT_SMOKE_KIND: process.env.SMOKE_LOCAL_KIND ?? 'openai',
    LLM_ENDPOINT_SMOKE_CONTEXT_WINDOW: String(contextWindow),
    LLM_ENDPOINT_SMOKE_PARALLEL_TOOLS: '1',
    LLM_ENDPOINT_SMOKE_USAGE_IN_STREAM: '1',
    ...(process.env.SMOKE_LOCAL_API_KEY ? { LLM_ENDPOINT_SMOKE_API_KEY: process.env.SMOKE_LOCAL_API_KEY } : {}),
    ...(process.env.SMOKE_LOCAL_REASONING_REPLAY
      ? { LLM_ENDPOINT_SMOKE_REASONING_REPLAY: process.env.SMOKE_LOCAL_REASONING_REPLAY }
      : {}),
    EGRESS_PRIVATE_CIDRS: '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    EGRESS_HTTP_HOSTS: `${target.host},127.0.0.1:${toolPort}`,
    EGRESS_ALLOWLIST: `127.0.0.1:${toolPort}`,
    EGRESS_PUBLIC_PROVIDERS: '0',
  }),
  {},
  'smoke-local',
)

const headers = { Authorization: 'Bearer smoke', 'Content-Type': 'application/json' }
const llm = { provider: 'endpoint', endpoint: 'smoke', model }
let failed = false
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) failed = true
}

async function run(body: Record<string, unknown>): Promise<any> {
  const res = await engine.app.request('/runs', { method: 'POST', headers, body: JSON.stringify({ contract_version: '1', llm, wait: true, ...body }) })
  return res.json()
}

// 1. a tool call, then an answer that uses the result
const tooled = await run({
  system: 'You are a warehouse assistant. Use the tools to answer.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'How many units of SKU A-17 are in stock? Use getStock.' }] }],
  tools: [
    {
      name: 'getStock',
      description: 'Stock level for a SKU',
      input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      endpoint: `http://127.0.0.1:${toolPort}/stock`,
      effect: 'read',
    },
  ],
  limits: { max_steps: 4, timeout_ms: 120_000 },
})
const toolCalled = tooled.messages?.some((m: any) => m.role === 'tool' && m.tool === 'getStock')
const answer = tooled.messages?.filter((m: any) => m.role === 'assistant').at(-1)?.content?.find((p: any) => p.type === 'text')?.text ?? ''
check(tooled.status === 'completed', 'tool run completed', tooled.status === 'completed' ? undefined : tooled.error ?? tooled)
check(Boolean(toolCalled), 'the model called getStock')
check(/42/.test(answer), 'the answer uses the tool result (42)', answer.slice(0, 200))
const calls = tooled.usage?.calls ?? []
check(calls.length > 0, `usage: ${calls.every((c: any) => !c.estimated) ? 'reported by the server' : 'estimated'}`, calls.map((c: any) => [c.input_tokens, c.output_tokens, c.estimated]))

// 2. cancel mid-stream
const started = await engine.app.request('/runs', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    contract_version: '1',
    llm,
    callback: { url: `http://127.0.0.1:${toolPort}/cb` },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a long story about a warehouse, at least 800 words.' }] }],
  }),
})
const { run_id } = (await started.json()) as { run_id: string }
await new Promise((r) => setTimeout(r, 1500))
const cancelled = (await (await engine.app.request(`/runs/${run_id}/cancel`, { method: 'POST', headers })).json()) as any
check(['cancelled', 'completed', 'cancelling'].includes(cancelled.status), 'cancel mid-stream', cancelled.status)

// 3. an oversized history: the engine must trim before the server cuts silently. Trimming
// drops middle turns only (the first user message and the last four are kept, SPEC §5.1), so
// the bulk sits in the middle
const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil((contextWindow * 0.5 * 4) / 27))
const middle = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `${i}: ${filler}` }],
}))
const big = await run({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
    ...middle,
    { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready.' }] },
  ],
  limits: { max_steps: 1, timeout_ms: 120_000 },
})
const trimmed = logBuffer().query({ runId: big.run_id, events: ['context_trimmed'], limit: 5 }).entries.length > 0
check(big.status === 'completed', 'oversized history completed', big.status === 'completed' ? undefined : big.error)
check(trimmed, 'the engine trimmed the history (context_trimmed)')

await engine.shutdown()
tools.close()
process.exit(failed ? 1 : 0)
