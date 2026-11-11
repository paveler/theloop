/**
 * The engine opens no outbound connection and resolves no name on its own (SPEC §14): only a
 * request, a run, a callback or ERROR_WEBHOOK_URL may cause one. The real entry point runs in a
 * child process with a preload that records connects and lookups; startup, /health, /metrics,
 * GET /logs and a refused POST /runs must record nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

let child: ChildProcess | null = null
let dir = ''
afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('engine did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('no outbound connection on its own (SPEC §14)', () => {
  it('startup, health, metrics, logs and a refused run: no connect, no lookup', async () => {
    dir = mkdtempSync(join(tmpdir(), 'theloop-noegress-'))
    const log = join(dir, 'egress.log')
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    child = spawn(
      process.execPath,
      ['--require', join(import.meta.dirname, 'fixtures/no-egress-preload.cjs'), '--import', 'tsx', 'src/index.ts'],
      {
        cwd: join(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH,
          NO_EGRESS_LOG: log,
          PORT: String(port),
          ENGINE_TOKEN: 't',
          METRICS_TOKEN: 'm',
          LOG_LEVEL: 'silent',
          LOG_DIR: join(dir, 'journal'),
          EGRESS_PUBLIC_PROVIDERS: '0',
          LLM_ENDPOINT_LOCAL_URL: 'https://llm.corp.example/v1',
          LLM_ENDPOINT_LOCAL_CONTEXT_WINDOW: '32000',
        },
        stdio: 'ignore',
      },
    )
    await waitHealthy(port)
    const auth = { Authorization: 'Bearer t', 'Content-Type': 'application/json' }
    expect((await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: 'Bearer m' } })).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/logs`, { headers: auth })).status).toBe(200)
    const refused = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contract_version: '1', llm: { provider: 'anthropic', model: 'x', api_key: 'k' }, messages: [] }),
    })
    expect(refused.status).toBe(400)
    // give timers a chance to fire
    await new Promise((r) => setTimeout(r, 1500))
    const recorded = existsSync(log) ? readFileSync(log, 'utf8').trim() : ''
    expect(recorded).toBe('')

    // control: a run against the endpoint does resolve its host — the preload sees egress
    await fetch(`http://127.0.0.1:${port}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        contract_version: '1',
        llm: { provider: 'endpoint', endpoint: 'local', model: 'm' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        limits: { timeout_ms: 3000 },
        wait: true,
      }),
    })
    expect(readFileSync(log, 'utf8')).toContain('llm.corp.example')
  }, 30_000)
})
