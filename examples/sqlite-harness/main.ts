/**
 * A chat in the terminal over the example harness.
 *
 *   terminal 1:  npm run dev                 # the engine; .env: ENGINE_TOKEN, ALLOW_INSECURE_EGRESS=1, a provider key
 *   terminal 2:  npm run example:sqlite      # this harness, the same .env
 *
 * Try "Where is my order 1042?", then "Please refund it", then /approve <id>.
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline/promises'
import { createHarness } from './harness.js'
import { openStore } from './store.js'

const ENGINE_URL = (process.env.ENGINE_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const ENGINE_TOKEN = process.env.ENGINE_TOKEN?.split(',')[0]?.trim()
const PORT = Number(process.env.HARNESS_PORT ?? 3100)
const SESSION = process.env.SESSION_ID ?? 'sess_demo'
const USER = 'u_demo'

if (!ENGINE_TOKEN) {
  console.error('ENGINE_TOKEN is required — the same value the engine uses')
  process.exit(1)
}

const store = openStore(process.env.DB_PATH ?? 'harness.db')
store.putOrder({ id: '1042', user_id: USER, status: 'delivered', total: 120, refunded: 0 })
store.putOrder({ id: '1043', user_id: USER, status: 'shipped', total: 35, refunded: 0 })

const harness = createHarness({
  store,
  engineUrl: ENGINE_URL,
  engineToken: ENGINE_TOKEN,
  publicUrl: `http://localhost:${PORT}`,
  callbackSecret: process.env.CALLBACK_SECRET || undefined,
  llm: { provider: process.env.LLM_PROVIDER ?? 'anthropic', model: process.env.LLM_MODEL ?? 'claude-sonnet-5' },
})

const server = createServer((req, res) => {
  harness.handle(req, res).catch((err) => {
    res.writeHead(500)
    res.end(String(err))
  })
})
await new Promise<void>((resolve) => server.listen(PORT, resolve))
setInterval(() => void harness.recover().catch((err) => console.error('recover:', err)), 10_000).unref()

console.log(`harness on http://localhost:${PORT}, engine ${ENGINE_URL}, session ${SESSION}`)
console.log('commands: /approve <id>, /reject <id>, /history, /quit\n')

/** Streams the answer from SSE, then waits until the callback has recorded the result. */
async function follow(runId: string, streamUrl: string): Promise<void> {
  const res = await fetch(streamUrl, { headers: { Accept: 'text/event-stream' } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (let done = false; !done; ) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !data) continue
      const payload = JSON.parse(data)
      if (event === 'delta') process.stdout.write(payload.text)
      if (event === 'snapshot' && payload.text) process.stdout.write(payload.text)
      if (event === 'tool_call') process.stdout.write(`\n[${payload.tool}]\n`)
      if (event === 'done') done = true
    }
  }
  await reader.cancel().catch(() => {})
  process.stdout.write('\n')

  for (let i = 0; i < 100 && store.run(runId)?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  for (const op of harness.pendingApprovals(SESSION)) {
    console.log(`  approval needed: refund ${op.fields.amount} for order ${op.fields.orderId} — /approve ${op.id} or /reject ${op.id}`)
  }
}

// for-await buffers lines, so piped input works as well as a terminal
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
rl.setPrompt('> ')
rl.prompt()
for await (const raw of rl) {
  const line = raw.trim()
  if (line === '/quit') break
  if (line === '/history') {
    for (const message of store.history(SESSION)) console.log(JSON.stringify(message))
  } else if (line) {
    try {
      const decision = /^\/(approve|reject)\s+(\S+)$/.exec(line)
      if (decision) {
        const op = store.operation(decision[2]!)
        if (!op) console.log('no such operation')
        else {
          const next = await harness.decide(op.id, decision[1] === 'approve' ? 'approve' : 'reject', op.version)
          if (next) await follow(next.runId, next.streamUrl)
          else console.log('recorded; the result will reach the conversation with your next message')
        }
      } else {
        const { runId, streamUrl } = await harness.send(SESSION, USER, line)
        await follow(runId, streamUrl)
      }
    } catch (err) {
      console.error(String(err))
    }
  }
  rl.prompt()
}
rl.close()
server.close()
