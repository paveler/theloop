/**
 * SSE check against a live engine: does text arrive as a STREAM, or does a proxy deliver it in one batch.
 *
 *   read -s ENGINE_TOKEN && export ENGINE_TOKEN
 *   npm run sse-check                                       # http://localhost:8080, GigaChat
 *   ENGINE_URL=https://loop.example.com npm run sse-check   # a deployed engine
 *   SSE_PROVIDER=anthropic SSE_MODEL=claude-sonnet-5 npm run sse-check
 *
 * Starts a run with a long answer, subscribes to stream_url right away and prints every
 * event with a timestamp. The verdict depends on how delta events are spread over time.
 */
const ENGINE_URL = (process.env.ENGINE_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const TOKEN = process.env.ENGINE_TOKEN
if (!TOKEN) {
  console.error('No ENGINE_TOKEN. First: read -s ENGINE_TOKEN && export ENGINE_TOKEN')
  process.exit(2)
}

const t0 = Date.now()
const at = () => `${String(Date.now() - t0).padStart(6)} ms`

// Without callback.url the contract allows only wait: true, and stream_url in such a response
// arrives only after the run ends. A workaround within the contract (SPEC §11.2): the run is
// started by a background request with an idempotency_key, and a repeat with the same key and
// body returns the stream_url of the running run at once.
const body = JSON.stringify({
  contract_version: '1',
  idempotency_key: `sse-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  llm: {
    provider: process.env.SSE_PROVIDER ?? 'gigachat',
    model: process.env.SSE_MODEL ?? 'GigaChat-2-Pro',
  },
  messages: [
    {
      role: 'user',
      // prose, not a list: GigaChat (Pro / Lite) emits text phrase by phrase, and a list without
      // punctuation arrives as a single event even with no proxy at all — measured
      content: [{ type: 'text', text: 'Explain in twenty sentences how a city water supply system works.' }],
    },
  ],
  limits: { max_steps: 1, max_tokens: 1500, timeout_ms: 90_000 },
  wait: true,
})
const post = (signal?: AbortSignal) =>
  fetch(`${ENGINE_URL}/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body,
    signal,
  })

const background = post().then(async (r) => ({ status: r.status, json: (await r.json()) as { error?: unknown } }))
background.catch(() => {})
await new Promise((r) => setTimeout(r, 300))

let start: Response
try {
  start = await post(AbortSignal.timeout(8_000))
} catch {
  console.error('The repeated POST did not return stream_url within 8 s — a request race, run it again.')
  process.exit(1)
}
const run = (await start.json()) as { run_id?: string; stream_url?: string; error?: unknown }
if (!run.stream_url) {
  // a configuration error shows up in the first request: no provider key, 401 and so on
  const first = await Promise.race([background, new Promise<null>((r) => setTimeout(() => r(null), 3_000))])
  console.error(`POST /runs: HTTP ${start.status}`, JSON.stringify(first?.json ?? run))
  process.exit(1)
}
console.log(`${at()}  run ${run.run_id} created`)
// the run token is in the query — do not print it
console.log(`${at()}  stream_url: ${run.stream_url.split('?')[0]}?token=…`)

const res = await fetch(run.stream_url, { headers: { Accept: 'text/event-stream' } })
console.log(`${at()}  stream: HTTP ${res.status}, ${res.headers.get('content-type')}`)
for (const h of ['x-accel-buffering', 'cache-control', 'content-encoding', 'via', 'server']) {
  const v = res.headers.get(h)
  if (v) console.log(`          ${h}: ${v}`)
}
if (!res.ok || !res.body) process.exit(1)

const deltaTimes: number[] = []
let networkChunks = 0
let chars = 0
let doneStatus = ''
let buffer = ''
const decoder = new TextDecoder()

for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  networkChunks++
  buffer += decoder.decode(chunk, { stream: true })
  const blocks = buffer.split('\n\n')
  buffer = blocks.pop() ?? ''
  for (const block of blocks) {
    const event = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (!event) continue // ": ping"
    if (event === 'delta') {
      deltaTimes.push(Date.now() - t0)
      const text = (JSON.parse(data ?? '{}') as { text?: string }).text ?? ''
      chars += text.length
      if (deltaTimes.length <= 5 || deltaTimes.length % 25 === 0) {
        console.log(`${at()}  delta #${deltaTimes.length}: ${JSON.stringify(text.slice(0, 30))}`)
      }
    } else if (event === 'done') {
      const d = JSON.parse(data ?? '{}') as { status?: string; finish_reason?: string }
      doneStatus = `${d.status}/${d.finish_reason}`
      console.log(`${at()}  done: ${doneStatus}`)
    } else {
      console.log(`${at()}  ${event}`)
    }
  }
  if (doneStatus) break
}

const n = deltaTimes.length
console.log('\n— summary —')
console.log(`delta events: ${n}, chars: ${chars}, network chunks: ${networkChunks}`)
if (n < 10) {
  console.log('VERDICT: too few events to judge. Compare with a local engine (ENGINE_URL=http://localhost:8080):')
  console.log('         if it is the same there, this is how the model emits text, not the proxy.')
  process.exit(1)
}
const spread = deltaTimes[n - 1]! - deltaTimes[0]!
let maxGap = 0
for (let i = 1; i < n; i++) maxGap = Math.max(maxGap, deltaTimes[i]! - deltaTimes[i - 1]!)
console.log(`first delta: ${deltaTimes[0]} ms, last: ${deltaTimes[n - 1]} ms, spread: ${spread} ms, max gap: ${maxGap} ms`)

if (spread < 300 || networkChunks <= 3) {
  console.log('VERDICT: BUFFERING — all the text arrived in one batch. A proxy holds the response back; the user sees it in one piece.')
  process.exit(1)
}
if (maxGap > spread * 0.6) {
  console.log('VERDICT: PARTIAL BUFFERING — text arrives in large portions with long pauses.')
  process.exit(1)
}
console.log('VERDICT: STREAMING — events are spread over the generation time, the proxy does not buffer.')
