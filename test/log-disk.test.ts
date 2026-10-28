/**
 * The journal on disk (SPEC §12.4, RFC 0002 part B): day files, prompts by hash, reads from
 * disk after a restart and past the memory ceiling, retention and the size ceiling.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import type { LogEntry } from '../src/log-buffer.js'
import { DiskJournal } from '../src/log-disk.js'
import {
  bearer,
  finish,
  mockFactory,
  mockModel,
  runRequest,
  START,
  streamFrom,
  textChunks,
  testConfig,
} from './helpers.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theloop-journal-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const today = () => new Date().toISOString().slice(0, 10)
const dayFile = (dir: string, day = today()) => join(dir, `journal-${day}.jsonl`)

function lines(dir: string, day = today()): Array<LogEntry & { boot_id?: string; sha256?: string }> {
  return readFileSync(dayFile(dir, day), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry)
}

function engineFor(dir: string, answers: number, env: Record<string, string> = {}): Engine {
  const model = mockModel(
    Array.from({ length: answers }, (_, i) => streamFrom([START, ...textChunks(`Answer ${i}`), finish('stop')])),
  )
  const engine = createEngine(testConfig({ LOG_DIR: dir, ...env }), { modelFactory: mockFactory(model) })
  cleanup.push(() => engine.shutdown())
  return engine
}

async function run(engine: Engine, overrides: Record<string, unknown> = {}): Promise<RunResult> {
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...runRequest(overrides), wait: true }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

interface LogsBody {
  entries: LogEntry[]
  truncated: boolean
  source: 'memory' | 'disk' | 'mixed'
}

async function getLogs(engine: Engine, path: string): Promise<LogsBody> {
  const res = await engine.app.request(path, { headers: bearer() })
  expect(res.status).toBe(200)
  return (await res.json()) as LogsBody
}

const SYSTEM = 'You are an online store assistant. Per-run context: order 12345, customer tier gold.'

describe('disk journal: writing', () => {
  it('entries go to the UTC day file on shutdown, 0600, with boot_id and the prompt by hash', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 1)
    const result = await run(engine, { system: SYSTEM })
    await engine.shutdown()

    const written = lines(dir)
    const start = written.find((e) => e.event === 'run_start' && e.run_id === result.run_id)!
    expect(start.boot_id).toMatch(/^[0-9a-f]{12}$/)
    expect(start.content!.system).toBeUndefined()
    const sha = start.content!.system_sha256 as string
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    const blobs = written.filter((e) => e.event === 'prompt_blob')
    expect(blobs).toHaveLength(1)
    expect(blobs[0]).toMatchObject({ sha256: sha, content: { text: SYSTEM } })
    expect(written.some((e) => e.event === 'run_done' && e.run_id === result.run_id)).toBe(true)
    expect(statSync(dayFile(dir)).mode & 0o777).toBe(0o600)
  })

  it('the same system in many runs → one prompt_blob per day file; GET /logs still shows system', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 5)
    const runs: RunResult[] = []
    for (let i = 0; i < 5; i++) runs.push(await run(engine, { system: SYSTEM }))
    await engine.shutdown()

    expect(lines(dir).filter((e) => e.event === 'prompt_blob')).toHaveLength(1)
    const { entries, source } = await getLogs(engine, `/runs/${runs[3]!.run_id}/logs?event=run_start`)
    expect(source).toBe('memory')
    expect(entries[0]!.content!.system).toBe(SYSTEM)
  })

  it('inline_prompts=false → the hash only', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 1)
    const result = await run(engine, { system: SYSTEM })
    const { entries } = await getLogs(engine, `/runs/${result.run_id}/logs?event=run_start&inline_prompts=false`)
    expect(entries[0]!.content!.system).toBeUndefined()
    expect(entries[0]!.content!.system_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('secrets are scrubbed on disk as in memory; disk content is not cut to LOG_CONTENT_MAX_CHARS', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 1, { LOG_CONTENT_MAX_CHARS: '20' })
    const long = `${SYSTEM} Key: sk-abcdef1234567890. ${'x'.repeat(5000)}`
    const result = await run(engine, { system: long })
    await engine.shutdown()

    const raw = readFileSync(dayFile(dir), 'utf8')
    expect(raw).not.toContain('sk-abcdef1234567890')
    expect(raw).toContain('sk-<redacted>')
    const blob = lines(dir).find((e) => e.event === 'prompt_blob')!
    expect((blob.content!.text as string).length).toBeGreaterThan(5000)
    // memory keeps its own cap
    const { entries } = await getLogs(engine, `/runs/${result.run_id}/logs?event=run_start`)
    expect(entries[0]!.content!.system).toMatch(/…\[\+\d+ chars\]$/)
  })

  it('LOG_BUFFER_CONTENT=0 → no content on disk either', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 1, { LOG_BUFFER_CONTENT: '0' })
    await run(engine, { system: SYSTEM })
    await engine.shutdown()
    const written = lines(dir)
    expect(written.some((e) => e.content)).toBe(false)
    expect(written.some((e) => e.event === 'prompt_blob')).toBe(false)
  })
})

describe('disk journal: reading', () => {
  it('after a restart GET /logs?session_id= reads the session from disk, system inlined', async () => {
    const dir = tempDir()
    const first = engineFor(dir, 1)
    const result = await run(first, { system: SYSTEM, meta: { session_id: 'sess-disk' } })
    await first.shutdown()

    const second = engineFor(dir, 0)
    const { entries, source } = await getLogs(second, '/logs?session_id=sess-disk')
    expect(source).toBe('disk')
    expect(entries[0]).toMatchObject({ event: 'run_start', run_id: result.run_id })
    expect(entries[0]!.content!.system).toBe(SYSTEM)
    expect(entries.at(-1)!.event).toBe('run_done')
    expect(entries.some((e) => e.event === 'prompt_blob')).toBe(false)

    // GET /runs/{id}/logs of a run that exists only on disk
    const byRun = await getLogs(second, `/runs/${result.run_id}/logs?format=json`)
    expect(byRun.source).toBe('disk')
    expect(byRun.entries.every((e) => e.session_id === 'sess-disk')).toBe(true)
  })

  it('memory evicted the start of a run → source mixed, in order', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 1, { LOG_BUFFER_MAX_ENTRIES: '4' })
    const result = await run(engine, { system: SYSTEM })

    const { entries, source } = await getLogs(engine, `/runs/${result.run_id}/logs`)
    expect(source).toBe('mixed')
    expect(entries[0]!.event).toBe('run_start')
    expect(entries.some((e) => e.event === 'run_done')).toBe(true)
    const seqs = entries.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('a tail that fell behind the memory ceiling continues from disk', async () => {
    const dir = tempDir()
    const engine = engineFor(dir, 3, { LOG_BUFFER_MAX_ENTRIES: '4' })
    await run(engine)
    await run(engine)
    await run(engine)

    const { entries, source } = await getLogs(engine, '/logs?since=0&limit=5')
    expect(source).not.toBe('memory')
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('days bounds the scan; an unknown run is still 404', async () => {
    const dir = tempDir()
    const old = '2020-01-01'
    writeFileSync(
      dayFile(dir, old),
      `${JSON.stringify({ seq: 1, at: `${old}T10:00:00.000Z`, level: 'info', event: 'run_start', run_id: 'run_OLD', boot_id: 'b0' })}\n`,
    )
    // retention would delete 2020 at startup: keep it with a long retention
    const engine = engineFor(dir, 0, { LOG_RETENTION_DAYS: '100000' })
    expect((await getLogs(engine, '/runs/run_OLD/logs')).source).toBe('disk')
    expect((await engine.app.request('/runs/run_OLD/logs?days=1', { headers: bearer() })).status).toBe(404)
    expect((await engine.app.request('/runs/run_NONE/logs', { headers: bearer() })).status).toBe(404)
  })
})

describe('disk journal: retention', () => {
  it('on startup: day files older than LOG_RETENTION_DAYS are deleted, journal_retention logged', async () => {
    const dir = tempDir()
    writeFileSync(dayFile(dir, '2020-01-01'), '{}\n')
    writeFileSync(join(dir, 'unrelated.txt'), 'keep')
    const engine = engineFor(dir, 0)

    expect(readdirSync(dir)).toEqual(expect.not.arrayContaining(['journal-2020-01-01.jsonl']))
    expect(readdirSync(dir)).toContain('unrelated.txt')
    const { entries } = await getLogs(engine, '/logs?event=journal_retention')
    expect(entries[0]).toMatchObject({ deleted: ['journal-2020-01-01.jsonl'] })
  })

  it('the hourly prune: by age, then by size oldest first; today is never deleted', () => {
    const dir = tempDir()
    const now = Date.parse('2026-10-28T12:00:00Z')
    for (const day of ['2026-10-18', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']) {
      writeFileSync(dayFile(dir, day), 'x'.repeat(100))
    }
    const journal = new DiskJournal({ dir, retentionDays: 7, maxBytes: 250 }, () => {})
    cleanup.push(() => journal.close())

    const report = journal.prune(now)
    expect(report.expired).toEqual(['journal-2026-10-18.jsonl'])
    expect(report.pruned).toEqual(['journal-2026-10-25.jsonl', 'journal-2026-10-26.jsonl'])
    expect(readdirSync(dir).sort()).toEqual(['journal-2026-10-27.jsonl', 'journal-2026-10-28.jsonl'])

    // a ceiling below today's file alone keeps today
    const tight = new DiskJournal({ dir, retentionDays: 0, maxBytes: 10 }, () => {})
    cleanup.push(() => tight.close())
    expect(tight.prune(now).expired).toEqual(['journal-2026-10-27.jsonl'])
    expect(readdirSync(dir)).toEqual(['journal-2026-10-28.jsonl'])
  })

  it('LOG_DIR_MAX_BYTES exceeded at startup → journal_pruned warning', async () => {
    const dir = tempDir()
    writeFileSync(dayFile(dir, yesterday()), 'x'.repeat(1000))
    const engine = engineFor(dir, 0, { LOG_DIR_MAX_BYTES: '10' })
    const { entries } = await getLogs(engine, '/logs?event=journal_pruned')
    expect(entries[0]).toMatchObject({ level: 'warn', deleted: [`journal-${yesterday()}.jsonl`] })
  })
})

function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}
