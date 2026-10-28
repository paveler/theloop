/**
 * The journal on disk (SPEC §12.4): every entry of the memory journal is also appended to
 * LOG_DIR/journal-YYYY-MM-DD.jsonl (UTC date of the entry), one JSON object per line, so a
 * deploy does not wipe it and GET /logs can read past the memory ceiling.
 *
 * - Writes are buffered and flushed every second and on shutdown: a deploy loses at most
 *   the last second.
 * - A prompt is written once per day file and process as a `prompt_blob` line; entries carry
 *   `content.system_sha256`.
 * - Day files older than LOG_RETENTION_DAYS are deleted on startup and hourly; over
 *   LOG_DIR_MAX_BYTES the oldest days go first. The current day is never deleted.
 * - Entries carry `boot_id`: `seq` restarts with the process.
 *
 * Single writer, no locking (§11.2). Reads stream the files line by line, newest day first,
 * with a substring prefilter before JSON.parse.
 */
import { createReadStream, existsSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { entryFilter, safeStringify, type LogEntry, type LogQuery, type PromptBlob } from './log-buffer.js'

const FILE_RE = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/
const FLUSH_INTERVAL_MS = 1000
const PRUNE_INTERVAL_MS = 3_600_000
const DAY_MS = 86_400_000
export const PROMPT_BLOB_EVENT = 'prompt_blob'

export interface DiskJournalSettings {
  dir: string
  retentionDays: number
  maxBytes: number
}

/** What a prune removed; the caller logs it (log.ts imports this module, not the other way round). */
export interface PruneReport {
  /** By age (LOG_RETENTION_DAYS). */
  expired: string[]
  /** By size (LOG_DIR_MAX_BYTES), oldest first. */
  pruned: string[]
  bytesBefore: number
  bytesAfter: number
}

export interface DiskQuery extends LogQuery {
  /** How many matches are wanted. */
  need: number
  /** Entries of the current boot with seq ≥ this are in memory: skipped. */
  memoryFromSeq: number | null
  /** Scan at most this many day files, newest first. */
  days?: number
}

export interface DiskQueryResult {
  entries: LogEntry[]
  /** More matches than `need` in the scanned files. */
  truncated: boolean
}

export class DiskJournal {
  readonly bootId = randomBytes(6).toString('hex')
  private pending = new Map<string, string[]>()
  /** day → prompt hashes already written to that day file by this process. */
  private blobsWritten = new Map<string, Set<string>>()
  private readonly flushTimer: ReturnType<typeof setInterval>
  private readonly pruneTimer: ReturnType<typeof setInterval>
  private writeFailed: ((err: unknown) => void) | null = null

  constructor(
    private readonly settings: DiskJournalSettings,
    onPrune: (report: PruneReport) => void,
  ) {
    mkdirSync(settings.dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(settings.dir, 0o700)
    } catch {
      // a mounted volume may not allow it; the files themselves are 0600
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.pruneTimer = setInterval(() => onPrune(this.prune()), PRUNE_INTERVAL_MS)
    this.flushTimer.unref()
    this.pruneTimer.unref()
  }

  get dir(): string {
    return this.settings.dir
  }

  onWriteError(handler: (err: unknown) => void): void {
    this.writeFailed = handler
  }

  /** The directory is on the root filesystem: without a mounted volume it dies with the container. */
  onRootFilesystem(): boolean {
    try {
      return statSync(this.settings.dir).dev === statSync('/').dev
    } catch {
      return false
    }
  }

  append(entry: LogEntry, content: Record<string, unknown> | undefined, blob: PromptBlob | undefined): void {
    const day = entry.at.slice(0, 10)
    let lines = this.pending.get(day)
    if (!lines) {
      lines = []
      this.pending.set(day, lines)
    }
    if (blob) {
      let written = this.blobsWritten.get(day)
      if (!written) {
        written = new Set()
        this.blobsWritten.set(day, written)
        // only today and yesterday get new lines: older sets are dead weight
        for (const old of this.blobsWritten.keys()) if (old < previousDay(day)) this.blobsWritten.delete(old)
      }
      if (!written.has(blob.sha256)) {
        written.add(blob.sha256)
        lines.push(
          safeStringify({
            seq: entry.seq,
            at: entry.at,
            level: 'debug',
            event: PROMPT_BLOB_EVENT,
            boot_id: this.bootId,
            sha256: blob.sha256,
            content: { text: blob.text },
          }),
        )
      }
    }
    const { content: _memory, ...meta } = entry
    lines.push(safeStringify({ ...meta, boot_id: this.bootId, ...(content ? { content } : {}) }))
  }

  flush(): void {
    if (this.pending.size === 0) return
    const batches = this.pending
    this.pending = new Map()
    for (const [day, lines] of batches) {
      if (lines.length === 0) continue
      try {
        appendFileSync(this.file(day), `${lines.join('\n')}\n`, { mode: 0o600 })
      } catch (err) {
        this.writeFailed?.(err)
      }
    }
  }

  close(): void {
    clearInterval(this.flushTimer)
    clearInterval(this.pruneTimer)
    this.flush()
  }

  /** Retention by age, then the size ceiling; the current UTC day is never deleted. */
  prune(now = Date.now()): PruneReport {
    const today = utcDay(now)
    const cutoff = utcDay(now - this.settings.retentionDays * DAY_MS)
    const report: PruneReport = { expired: [], pruned: [], bytesBefore: 0, bytesAfter: 0 }
    const files: Array<{ name: string; day: string; bytes: number }> = []
    for (const { name, day } of this.dayFiles()) {
      let bytes = 0
      try {
        bytes = statSync(join(this.settings.dir, name)).size
      } catch {
        continue
      }
      report.bytesBefore += bytes
      if (day < cutoff && day !== today && this.remove(name)) {
        report.expired.push(name)
        continue
      }
      files.push({ name, day, bytes })
    }
    let total = files.reduce((acc, f) => acc + f.bytes, 0)
    for (const file of files) {
      if (total <= this.settings.maxBytes) break
      if (file.day === today) break
      if (!this.remove(file.name)) continue
      report.pruned.push(file.name)
      total -= file.bytes
    }
    report.bytesAfter = total
    return report
  }

  /**
   * Matches on disk that memory does not hold, newest day first, until `need` are found.
   * With `since`: entries of the current boot after it. The result is in file order.
   */
  async query(q: DiskQuery): Promise<DiskQueryResult> {
    this.flush()
    const matches = entryFilter(q)
    const needles = [
      q.runId ? `"run_id":${JSON.stringify(q.runId)}` : null,
      q.sessionId ? `"session_id":${JSON.stringify(q.sessionId)}` : null,
    ].filter((n): n is string => n !== null)
    const files = this.dayFiles().reverse().slice(0, q.days ?? Number.POSITIVE_INFINITY)

    const found: LogEntry[] = []
    let truncated = false
    for (const { name } of files) {
      const inFile: LogEntry[] = []
      await eachLine(join(this.settings.dir, name), (line) => {
        if (needles.some((n) => !line.includes(n))) return
        let entry: LogEntry & { boot_id?: string }
        try {
          entry = JSON.parse(line) as LogEntry & { boot_id?: string }
        } catch {
          return
        }
        if (entry.event === PROMPT_BLOB_EVENT) return
        const current = entry.boot_id === this.bootId
        if (current && q.memoryFromSeq != null && entry.seq >= q.memoryFromSeq) return
        if (q.since != null && (!current || entry.seq <= q.since)) return
        if (!matches(entry)) return
        inFile.push(entry)
      })
      if (q.since != null) {
        // a tail page: the first `need` after since, which may sit in an older file
        found.unshift(...inFile)
        continue
      }
      const room = q.need - found.length
      if (inFile.length > room) truncated = true
      found.unshift(...inFile.slice(Math.max(0, inFile.length - room)))
      if (found.length >= q.need) break
    }
    if (q.since != null) {
      found.sort((a, b) => a.seq - b.seq)
      if (found.length > q.need) truncated = true
      return { entries: found.slice(0, q.need), truncated }
    }
    return { entries: found, truncated }
  }

  /** The prompt text of a `prompt_blob` line in the day file of `at`. */
  async blob(sha256: string, at: string): Promise<string | undefined> {
    this.flush()
    const path = this.file(at.slice(0, 10))
    if (!existsSync(path)) return undefined
    const needle = `"sha256":${JSON.stringify(sha256)}`
    let text: string | undefined
    await eachLine(path, (line) => {
      if (text !== undefined || !line.includes(needle)) return
      try {
        const entry = JSON.parse(line) as { event?: string; content?: { text?: unknown } }
        if (entry.event === PROMPT_BLOB_EVENT && typeof entry.content?.text === 'string') text = entry.content.text
      } catch {
        // a torn line: skip
      }
    })
    return text
  }

  private file(day: string): string {
    return join(this.settings.dir, `journal-${day}.jsonl`)
  }

  /** Day files, oldest first. */
  private dayFiles(): Array<{ name: string; day: string }> {
    let names: string[]
    try {
      names = readdirSync(this.settings.dir)
    } catch {
      return []
    }
    return names
      .map((name) => ({ name, day: FILE_RE.exec(name)?.[1] }))
      .filter((f): f is { name: string; day: string } => f.day !== undefined)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }

  private remove(name: string): boolean {
    try {
      unlinkSync(join(this.settings.dir, name))
      return true
    } catch {
      return false
    }
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function previousDay(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS)
}

async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) if (line.length > 0) onLine(line)
  } catch {
    // the file was pruned mid-read: what was read stands
  } finally {
    lines.close()
    stream.destroy()
  }
}
