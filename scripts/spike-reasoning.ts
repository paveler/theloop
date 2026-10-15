/**
 * Spike (live, Anthropic): reasoning round trip across a run boundary.
 *
 * Checks what mocks cannot: Anthropic requires thinking blocks to be returned
 * WITH THEIR SIGNATURE and unchanged when a turn continues after tool use.
 * Here `deferred` splits such a turn into two runs (SPEC §5.2), so reasoning
 * must survive serialization into StoredMessage and back.
 *
 *   ANTHROPIC_API_KEY=… npm run spike:reasoning
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine } from '../src/app.js'
import { createConfig } from '../src/config.js'
import type { RunResult, StoredMessage } from '../src/contracts.js'

loadDotEnv()

const ENGINE_TOKEN = 'spike-token'
const MODEL = process.env.SPIKE_MODEL ?? 'claude-sonnet-5'

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required in .env or the environment')
    process.exit(2)
  }

  // write tool: always deferred — this is what splits the turn into two runs (SPEC §6.4)
  const tools = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'deferred', operation_id: 'op_spike_1' }))
    })
  })
  await new Promise<void>((r) => tools.listen(0, '127.0.0.1', r))
  const toolUrl = `http://127.0.0.1:${(tools.address() as AddressInfo).port}/issueRefund`

  const engine = createEngine(
    createConfig({ ...process.env, ENGINE_TOKEN, ALLOW_INSECURE_EGRESS: '1', LOG_LEVEL: 'warn' }),
  )

  const tool = {
    name: 'issueRefund',
    description: 'Issue a refund for an order',
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, sum: { type: 'number' } },
      required: ['order_id', 'sum'],
    },
    endpoint: toolUrl,
    effect: 'write' as const,
  }

  const base = {
    contract_version: '1',
    llm: {
      provider: 'anthropic',
      model: MODEL,
      params: { thinking: { budget_tokens: 2048 } },
    },
    system: 'You are a refunds assistant. Think before issuing a refund.',
    tools: [tool],
    limits: { max_steps: 4, max_tokens: 6000, timeout_ms: 180_000 },
    wait: true,
  }

  const history: StoredMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Refund order 1042 for 120 EUR. Think first whether everything adds up.',
        },
      ],
    },
  ]

  console.log('— run 1: expecting thinking + tool_call → awaiting_tool')
  const run1 = await call(engine, {
    ...base,
    idempotency_key: 'spike_msg_1',
    history_revision: 1,
    meta: { session_id: 'spike_sess' },
    messages: history,
  })
  report('run 1', run1)

  const reasoning = findReasoning(run1.messages)
  if (run1.status !== 'awaiting_tool') fail(`run 1: expected awaiting_tool, got ${run1.status}`)
  if (!reasoning) fail('run 1 returned no reasoning part — the model did not think, the spike is pointless')
  console.log(`  reasoning: text ${reasoning.text?.length ?? 0} chars, provider_metadata =`, Object.keys(reasoning.provider_metadata))
  if (Object.keys(reasoning.provider_metadata).length === 0) {
    fail('reasoning without provider_metadata — the signature is lost, Anthropic will reject the continued turn')
  }

  const callPart = run1.messages
    .filter((m): m is Extract<StoredMessage, { role: 'assistant' }> => m.role === 'assistant')
    .flatMap((m) => m.content)
    .find((p) => p.type === 'tool_call')
  if (!callPart || callPart.type !== 'tool_call') fail('run 1 returned no tool_call')

  console.log('— run 2: same history + the operation result, the turn continues')
  const continued: StoredMessage[] = [
    ...history,
    ...run1.messages,
    {
      role: 'tool',
      call_id: (callPart as { call_id: string }).call_id,
      tool: 'issueRefund',
      operation_id: 'op_spike_1',
      result: { status: 'refunded', number: 'RF-2026-777' },
      is_error: false,
    },
  ]

  const run2 = await call(engine, {
    ...base,
    idempotency_key: 'spike_msg_2',
    history_revision: 2,
    meta: { session_id: 'spike_sess_2' },
    messages: continued,
  })
  report('run 2', run2)

  if (run2.status !== 'completed') {
    fail(`run 2: expected completed, got ${run2.status}/${run2.finish_reason}: ${JSON.stringify(run2.error)}`)
  }

  const metaAfter = findReasoning(run2.messages)
  console.log('\n✓ SPIKE PASSED: Anthropic accepted the signed thinking block after the turn was split into two runs')
  console.log(`  run 2 reasoning: ${metaAfter ? 'present' : 'none (the turn needed no new thinking)'}`)
  console.log(`  answer: ${assistantText(run2.messages).slice(0, 200).replace(/\s+/g, ' ')}`)

  await engine.shutdown()
  await new Promise<void>((r) => tools.close(() => r()))
}

async function call(
  engine: ReturnType<typeof createEngine>,
  body: Record<string, unknown>,
): Promise<RunResult> {
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENGINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json()) as RunResult
  if (res.status !== 200) fail(`HTTP ${res.status}: ${JSON.stringify(parsed)}`)
  return parsed
}

function findReasoning(
  messages: StoredMessage[],
): { text?: string; provider_metadata: Record<string, unknown> } | null {
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'reasoning') return part
    }
  }
  return null
}

function assistantText(messages: StoredMessage[]): string {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m as { content: Array<{ type: string; text?: string }> }).content)
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
}

function report(label: string, result: RunResult): void {
  console.log(
    `  ${label}: ${result.status}/${result.finish_reason}, steps ${result.timing.steps}, ` +
      `tokens ${result.usage.total.input_tokens}/${result.usage.total.output_tokens}` +
      (result.error ? `, error ${result.error.code}` : ''),
  )
}

function fail(message: string): never {
  console.error(`\n✗ SPIKE FAILED: ${message}`)
  process.exit(1)
}

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
