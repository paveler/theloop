/**
 * In-memory event journal (SPEC §12.4): a ring buffer read by
 * GET /logs and GET /runs/{id}/logs. Everything that goes through log.* from log.ts is recorded,
 * at any level: the LOG_LEVEL filter applies to stdout only.
 *
 * No database: a restart / deploy means an empty journal. Ceilings on entry count and bytes;
 * on overflow old entries are evicted in a batch down to 90% of the ceiling.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_RANK: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 }

/** How many run_id → session_id pairs to remember for the session filter. */
const SESSION_MAP_MAX = 10_000

export interface LogEntry {
  seq: number
  at: string
  level: LogLevel
  event: string
  run_id?: string
  session_id?: string
  content?: Record<string, unknown>
  [field: string]: unknown
}

export interface LogQuery {
  runId?: string
  sessionId?: string
  events?: string[]
  minLevel?: LogLevel
  /** seq of the last seen entry: only entries strictly after it are returned (tail -f). */
  since?: number
  limit: number
}

export interface LogQueryResult {
  entries: LogEntry[]
  /** More matches than limit: without since the last ones are returned, with since the first ones. */
  truncated: boolean
}

export interface LogBufferStats {
  entries: number
  bytes: number
  /** How many entries have been evicted since the process started. */
  dropped: number
  oldest_at: string | null
  last_seq: number
}

interface Slot {
  entry: LogEntry
  bytes: number
}

export class LogBuffer {
  private slots: Slot[] = []
  private bytes = 0
  private seq = 0
  private dropped = 0
  private readonly sessionByRun = new Map<string, string>()

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  push(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown>,
    content: Record<string, unknown> | undefined,
  ): void {
    if (this.maxEntries <= 0 || this.maxBytes <= 0) return

    const entry: LogEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level,
      event,
      ...fields,
      ...(content ? { content } : {}),
    }

    // not every event of a run carries session_id; fill it in so that the session
    // filter sees the whole run, not just run_start
    const runId = typeof entry.run_id === 'string' ? entry.run_id : null
    if (runId) {
      if (typeof entry.session_id === 'string') this.rememberSession(runId, entry.session_id)
      else {
        const sessionId = this.sessionByRun.get(runId)
        if (sessionId) entry.session_id = sessionId
      }
    }

    const bytes = Buffer.byteLength(safeStringify(entry), 'utf8')
    this.slots.push({ entry, bytes })
    this.bytes += bytes
    if (this.slots.length > this.maxEntries || this.bytes > this.maxBytes) this.evict()
  }

  query(q: LogQuery): LogQueryResult {
    const minRank = q.minLevel ? LEVEL_RANK[q.minLevel] : 0
    const events = q.events && q.events.length > 0 ? new Set(q.events) : null
    const matched: LogEntry[] = []
    for (const { entry } of this.slots) {
      if (q.since != null && entry.seq <= q.since) continue
      if (q.runId && entry.run_id !== q.runId) continue
      if (q.sessionId && entry.session_id !== q.sessionId) continue
      if (events && !events.has(entry.event)) continue
      if (LEVEL_RANK[entry.level] < minRank) continue
      matched.push(entry)
    }
    if (matched.length <= q.limit) return { entries: matched, truncated: false }
    return {
      entries: q.since != null ? matched.slice(0, q.limit) : matched.slice(-q.limit),
      truncated: true,
    }
  }

  stats(): LogBufferStats {
    return {
      entries: this.slots.length,
      bytes: this.bytes,
      dropped: this.dropped,
      oldest_at: this.slots[0]?.entry.at ?? null,
      last_seq: this.seq,
    }
  }

  private rememberSession(runId: string, sessionId: string): void {
    if (this.sessionByRun.has(runId)) return
    this.sessionByRun.set(runId, sessionId)
    if (this.sessionByRun.size > SESSION_MAP_MAX) {
      const oldest = this.sessionByRun.keys().next().value
      if (oldest !== undefined) this.sessionByRun.delete(oldest)
    }
  }

  private evict(): void {
    const targetEntries = Math.floor(this.maxEntries * 0.9)
    const targetBytes = Math.floor(this.maxBytes * 0.9)
    let drop = 0
    let freed = 0
    while (
      drop < this.slots.length &&
      (this.slots.length - drop > targetEntries || this.bytes - freed > targetBytes)
    ) {
      freed += this.slots[drop]!.bytes
      drop++
    }
    this.slots.splice(0, drop)
    this.bytes -= freed
    this.dropped += drop
  }
}

/**
 * Human-readable timeline for `?format=text`: UTC time, +ms from the first entry,
 * level, event, key=value fields; content on separate indented lines.
 * `hide`: fields common to the whole selection (run_id when filtering by run).
 */
export function formatLogText(entries: readonly LogEntry[], hide: readonly string[] = []): string {
  if (entries.length === 0) return ''
  const first = Date.parse(entries[0]!.at)
  const hidden = new Set(hide)
  const lines: string[] = []
  for (const entry of entries) {
    const { seq: _seq, at, level, event, content, ...fields } = entry
    const delta = `+${Date.parse(at) - first}ms`
    const head = `${at.slice(11, 23)}Z ${delta.padStart(9)} ${level.toUpperCase().padEnd(5)} ${event}`
    const pairs = Object.entries(fields)
      .filter(([key, value]) => value !== undefined && value !== null && !hidden.has(key))
      .map(([key, value]) => `${key}=${inlineValue(value)}`)
    lines.push(pairs.length > 0 ? `${head}  ${pairs.join(' ')}` : head)
    if (content) {
      for (const [key, value] of Object.entries(content)) {
        if (value === undefined) continue
        const text = typeof value === 'string' ? value : safeStringify(value)
        lines.push(`      ${key}: ${text.replace(/\n/g, '\n        ')}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function inlineValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value
  if (typeof value === 'object') return safeStringify(value)
  return String(value)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}
