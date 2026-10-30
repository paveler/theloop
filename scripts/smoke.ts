/**
 * Live smoke run (SPEC §13, item 7): keys from .env, real network, not run in CI.
 *
 *   npm run smoke                 # every provider with a key
 *   npm run smoke -- anthropic    # just one
 *
 * GigaChat needs the Russian Trusted Root CA — this npm script builds the bundle from certs/*.crt:
 *   npm run smoke:gigachat
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine } from '../src/app.js'
import { createConfig } from '../src/config.js'
import type { RunResult } from '../src/contracts.js'

loadDotEnv()

const ENGINE_TOKEN = process.env.ENGINE_TOKEN ?? 'smoke-token'

interface Case {
  id: string
  provider: string
  model: string
  envKey: string
  thinking?: boolean
  /** The model sees images — a second run with a screenshot (SPEC §5.3). */
  vision?: boolean
  /** limits.max_tokens; default 4096. MiniMax counts thinking toward max_tokens. */
  maxTokens?: number
  /**
   * getWeather is deferred behind a skill (SPEC §6.8): the tool must arrive through
   * load_skill (tool_reference on Anthropic), and a second run on that history must read the cache.
   */
  skills?: boolean
}

const CASES: Case[] = [
  {
    id: 'anthropic',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    envKey: 'ANTHROPIC_API_KEY',
    thinking: true,
    vision: true,
  },
  { id: 'anthropic-skills', provider: 'anthropic', model: 'claude-sonnet-5', envKey: 'ANTHROPIC_API_KEY', skills: true },
  { id: 'openai', provider: 'openai', model: 'gpt-4o-mini', envKey: 'OPENAI_API_KEY', vision: true },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY' },
  // GLM: without params.thinking the engine turns thinking off; 5.3 cannot turn it off — depth low (SPEC §9.3)
  { id: 'glm', provider: 'glm', model: 'glm-4.7', envKey: 'GLM_API_KEY' },
  { id: 'glm-5.3', provider: 'glm', model: 'glm-5.3', envKey: 'GLM_API_KEY', maxTokens: 16_000 },
  // thinking on: reasoning_content goes back on the second step (SPEC §5.2)
  { id: 'glm-think', provider: 'glm', model: 'glm-4.7', envKey: 'GLM_API_KEY', thinking: true, maxTokens: 16_000 },
  { id: 'glm-vision', provider: 'glm', model: 'glm-4.6v', envKey: 'GLM_API_KEY', vision: true },
  // Lite (GigaChat-2) does not see images — SMOKE_MODEL=GigaChat-2 fails the vision run with 422
  { id: 'gigachat', provider: 'gigachat', model: 'GigaChat-2-Pro', envKey: 'GIGACHAT_AUTH_KEY', vision: true },
  // M2.x always think; signed thinking blocks go back on the second step — this is what smoke checks
  { id: 'minimax', provider: 'minimax', model: 'MiniMax-M2.7', envKey: 'MINIMAX_API_KEY', maxTokens: 16_000 },
  {
    id: 'minimax-m3',
    provider: 'minimax',
    model: 'MiniMax-M3',
    envKey: 'MINIMAX_API_KEY',
    thinking: true,
    vision: true,
    maxTokens: 16_000,
  },
  // K3 always thinks; the thinking block (empty signature) goes back on the second step.
  // Without params.thinking the depth is low, with it — from the budget (SPEC §9.3)
  { id: 'kimi', provider: 'kimi', model: 'kimi-k3.1-pro', envKey: 'KIMI_API_KEY', maxTokens: 16_000 },
  { id: 'kimi-think', provider: 'kimi', model: 'kimi-k3.1-pro', envKey: 'KIMI_API_KEY', thinking: true, vision: true, maxTokens: 16_000 },
]

/** PNG with a request code (4721) on it — the model must read the code. */
const IMAGE_URL = `data:image/png;base64,${readFileSync(new URL('./fixtures/smoke-image.png', import.meta.url)).toString('base64')}`
const IMAGE_CODE = '4721'

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  // SMOKE_MODEL=GigaChat-2-Max npm run smoke:gigachat — another model of the same provider
  const cases = CASES.filter((c) => (only.length === 0 ? true : only.includes(c.id))).map((c) =>
    process.env.SMOKE_MODEL && only.length === 1 ? { ...c, model: process.env.SMOKE_MODEL } : c,
  )

  // local tool endpoint: a read tool that answers synchronously
  const tools = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { args?: { city?: string } }
      const city = body.args?.city ?? 'unknown'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', result: { city, temperature_c: -3, condition: 'snow' } }))
    })
  })
  await new Promise<void>((r) => tools.listen(0, '127.0.0.1', r))
  const toolUrl = `http://127.0.0.1:${(tools.address() as AddressInfo).port}/getWeather`

  const engine = createEngine(
    createConfig({
      ...process.env,
      ENGINE_TOKEN,
      ALLOW_INSECURE_EGRESS: '1',
      EGRESS_ALLOWLIST: process.env.EGRESS_ALLOWLIST ?? '',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    }),
  )

  let failures = 0
  for (const testCase of cases) {
    if (!process.env[testCase.envKey]) {
      console.log(`— ${testCase.id}: skipped, no ${testCase.envKey}`)
      continue
    }
    try {
      const result = await runCase(engine, testCase, toolUrl)
      const text = answerText(result)
      // smoke checks tools too: the model must call getWeather, not make the weather up
      const ok = result.status === 'completed' && result.tool_calls.length > 0
      console.log(
        `${ok ? '✓' : '✗'} ${testCase.id} (${testCase.model}): ${result.status}/${result.finish_reason}, steps ${result.timing.steps}, ` +
          `tools ${result.tool_calls.length}, tokens ${result.usage.total.input_tokens}/${result.usage.total.output_tokens}, ` +
          `cache read ${result.usage.total.cache_read_tokens}, cache write ${result.usage.total.cache_write_tokens}, reasoning blocks ${reasoningParts(result)}`,
      )
      console.log(`  answer: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      if (!ok) failures++
      if (result.status === 'completed' && result.tool_calls.length === 0) {
        console.log('  tool not called — the provider ignored tools or the model answered from memory')
      }
      if (result.error) console.log(`  error: ${JSON.stringify(result.error)}`)
      if (testCase.skills) failures += await skillsFollowUp(engine, testCase, toolUrl, result)
    } catch (err) {
      failures++
      console.log(`✗ ${testCase.id}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!testCase.vision) continue
    try {
      // image and text in one message, tools in the request too — as in real use
      const result = await runCase(engine, testCase, toolUrl, [
        { type: 'text', text: 'What is the request code in the image? Answer with the number only.' },
        { type: 'image', url: IMAGE_URL },
      ])
      const text = answerText(result)
      const ok = result.status === 'completed' && text.includes(IMAGE_CODE)
      console.log(
        `${ok ? '✓' : '✗'} ${testCase.id} image: ${result.status}/${result.finish_reason}, ` +
          `tokens ${result.usage.total.input_tokens}/${result.usage.total.output_tokens}`,
      )
      console.log(`  answer: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      if (!ok) failures++
      if (result.error) console.log(`  error: ${JSON.stringify(result.error)}`)
    } catch (err) {
      failures++
      console.log(`✗ ${testCase.id} image: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await engine.shutdown()
  await new Promise<void>((r) => tools.close(() => r()))
  process.exit(failures > 0 ? 1 : 0)
}

/** The skill was loaded and the tool called; the next turn on that history reads the cache. */
async function skillsFollowUp(
  engine: ReturnType<typeof createEngine>,
  testCase: Case,
  toolUrl: string,
  first: RunResult,
): Promise<number> {
  const loaded = first.tool_calls.some((c) => c.tool === 'load_skill' && c.builtin && c.status === 'ok')
  const called = first.tool_calls.some((c) => c.tool === 'getWeather' && c.status === 'ok')
  console.log(`  ${loaded && called ? '✓' : '✗'} load_skill then getWeather: ${first.tool_calls.map((c) => c.tool).join(', ')}`)
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'What is the weather in Berlin? Answer in one sentence.' }] },
    ...first.messages,
  ]
  const second = await runCase(engine, testCase, toolUrl, [{ type: 'text', text: 'And in Paris?' }], history)
  const cacheRead = second.usage.calls[0]?.cache_read_tokens ?? 0
  console.log(`  ${cacheRead > 0 ? '✓' : '✗'} second turn: ${second.status}, step 1 cache read ${cacheRead}`)
  return (loaded && called ? 0 : 1) + (cacheRead > 0 ? 0 : 1)
}

function reasoningParts(result: RunResult): number {
  return result.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m as { content: Array<{ type: string }> }).content)
    .filter((p) => p.type === 'reasoning').length
}

function answerText(result: RunResult): string {
  return result.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m as { content: Array<{ type: string; text?: string }> }).content)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

async function runCase(
  engine: ReturnType<typeof createEngine>,
  testCase: Case,
  toolUrl: string,
  content: Array<Record<string, unknown>> = [{ type: 'text', text: 'What is the weather in Berlin? Answer in one sentence.' }],
  history: unknown[] = [],
): Promise<RunResult> {
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENGINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contract_version: '1',
      llm: {
        provider: testCase.provider,
        model: testCase.model,
        ...(testCase.thinking ? { params: { thinking: { budget_tokens: 2048 } } } : {}),
      },
      // the skills case needs a prefix above the provider's minimum cacheable size
      system: testCase.skills
        ? `You are a concise assistant.\n\n${'Weather answers are short, factual and name the city. '.repeat(250)}`
        : 'You are a concise assistant. If you need the weather, call the getWeather tool.',
      messages: [...history, { role: 'user', content }],
      tools: [
        {
          name: 'getWeather',
          description: 'Current weather in a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City' } },
            required: ['city'],
          },
          endpoint: toolUrl,
          effect: 'read',
          ...(testCase.skills ? { defer_loading: true } : {}),
        },
      ],
      ...(testCase.skills
        ? {
            skills: [
              {
                name: 'weather',
                description: 'Current weather lookups. Use when the user asks about the weather.',
                body: '# Weather\n\nCall getWeather with the city name and answer in one sentence.',
                tools: ['getWeather'],
              },
            ],
          }
        : {}),
      limits: { max_steps: 4, max_tokens: testCase.maxTokens ?? 4096, timeout_ms: 120_000 },
      wait: true,
    }),
  })

  const body = (await res.json()) as RunResult & { error?: { message?: string } }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

/** A tiny .env parser — not worth pulling in dotenv for a smoke script. */
function loadDotEnv(file = '.env'): void {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!match?.[1]) continue
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (process.env[match[1]] == null) process.env[match[1]] = value
  }
}

void main()
