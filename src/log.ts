/**
 * Logs (SPEC §12.2, §12.4): pino to stdout + an in-memory journal for GET /logs, and with
 * LOG_DIR the same journal on disk.
 *
 * An event = metadata + optional content (prompt, model texts, tool args /
 * results). Metadata goes to stdout and the journal, with run_id on every line that has one.
 * content goes only to the journal (LOG_BUFFER_CONTENT, on by default), to stdout only
 * with LOG_PROMPTS=1 (local). Every content field is clipped to LOG_CONTENT_MAX_CHARS in
 * memory and stdout, to LOG_DISK_CONTENT_MAX_CHARS on disk. `content.system` is journaled
 * once by hash as `system_sha256`. Keys and header values are never written anywhere.
 */
import { createHash } from 'node:crypto'
import pino from 'pino'
import type { Config } from './config.js'
import { LogBuffer, type LogLevel, type PromptBlob } from './log-buffer.js'
import { DiskJournal, type PruneReport } from './log-disk.js'

export type Logger = pino.Logger
export type LogFields = Record<string, unknown>

type LogSettings = Pick<
  Config,
  | 'logLevel'
  | 'logPrompts'
  | 'logBufferMaxEntries'
  | 'logBufferMaxBytes'
  | 'logBufferContent'
  | 'logContentMaxChars'
  | 'logDir'
  | 'logRetentionDays'
  | 'logDirMaxBytes'
  | 'logDiskContentMaxChars'
>

let root: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
let buffer = new LogBuffer(20_000, 33_554_432)
let contentToBuffer = true
let contentToStdout = false
let contentMaxChars = 4000
let disk: DiskJournal | null = null
let diskContentMaxChars = 200_000
let exitHook = false

export function initLogger(settings: LogSettings): Logger {
  root = pino({ level: settings.logLevel })
  buffer = new LogBuffer(settings.logBufferMaxEntries, settings.logBufferMaxBytes)
  contentToBuffer = settings.logBufferContent
  contentToStdout = settings.logPrompts
  contentMaxChars = settings.logContentMaxChars
  diskContentMaxChars = settings.logDiskContentMaxChars
  disk?.close()
  disk = null
  if (settings.logDir) {
    disk = new DiskJournal(
      { dir: settings.logDir, retentionDays: settings.logRetentionDays, maxBytes: settings.logDirMaxBytes },
      logPrune,
    )
    disk.onWriteError((err) => root.warn({ err: String(err) }, 'journal_write_failed'))
    // appendFileSync: the last second of entries reaches the disk even on process.exit
    if (!exitHook) {
      exitHook = true
      process.on('exit', () => disk?.flush())
    }
    if (disk.onRootFilesystem()) log.warn('journal_disk_ephemeral', { dir: settings.logDir })
    logPrune(disk.prune())
  }
  return root
}

function logPrune(report: PruneReport): void {
  if (report.expired.length > 0) log.info('journal_retention', { deleted: report.expired })
  if (report.pruned.length > 0) {
    log.warn('journal_pruned', {
      deleted: report.pruned,
      bytes_before: report.bytesBefore,
      bytes_after: report.bytesAfter,
    })
  }
}

/** The disk journal, when LOG_DIR is set. */
export function diskJournal(): DiskJournal | null {
  return disk
}

/** Writes the buffered tail of the disk journal (shutdown). */
export function flushJournal(): void {
  disk?.flush()
}

/** Bare pino, for the access log only: it does not go to the journal, otherwise GET /logs would spam itself. */
export function logger(): Logger {
  return root
}

export function logBuffer(): LogBuffer {
  return buffer
}

export function logContentEnabled(): boolean {
  return contentToBuffer
}

function emit(level: LogLevel, event: string, fields: LogFields = {}, content?: LogFields): void {
  if (content && contentToStdout) root[level]({ ...fields, content: clipContent(content, contentMaxChars) }, event)
  else root[level](fields, event)

  if (!content || !contentToBuffer) {
    const entry = buffer.push(level, event, fields, undefined)
    disk?.append(entry, undefined, undefined)
    return
  }
  // the prompt is the bulk of run_start and the same run after run: stored once by hash (§12.4)
  let rest = content
  let prompt: string | null = null
  let sha256: string | null = null
  if (typeof content.system === 'string') {
    prompt = redactSecrets(content.system)
    sha256 = createHash('sha256').update(prompt).digest('hex')
    const { system: _system, ...others } = content
    rest = others
  }
  // the hash is not content: never clipped
  const journaled = (max: number): LogFields => ({ ...(sha256 ? { system_sha256: sha256 } : {}), ...clipContent(rest, max) })
  const blob = (max: number): PromptBlob | undefined =>
    prompt !== null && sha256 !== null ? { sha256, text: clipString(prompt, max) } : undefined
  const entry = buffer.push(level, event, fields, journaled(contentMaxChars), blob(contentMaxChars))
  disk?.append(entry, journaled(diskContentMaxChars), blob(diskContentMaxChars))
}

/**
 * `log.info('step_done', { run_id, step }, { text })`: the third argument (content)
 * never reaches stdout (SPEC §12.2).
 */
export const log = {
  debug: (event: string, fields?: LogFields, content?: LogFields) => emit('debug', event, fields, content),
  info: (event: string, fields?: LogFields, content?: LogFields) => emit('info', event, fields, content),
  warn: (event: string, fields?: LogFields, content?: LogFields) => emit('warn', event, fields, content),
  error: (event: string, fields?: LogFields, content?: LogFields) => emit('error', event, fields, content),
}

function clipContent(content: LogFields, maxChars: number): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined) continue
    out[key] = clipValue(value, maxChars)
  }
  return out
}

/**
 * A string is clipped as is; a structure is serialized and, if it fits, stored as a
 * copy (not a reference to the run's live messages), otherwise as a clipped string.
 */
function clipValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') return clipString(redactSecrets(value), maxChars)
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    return '[unserializable]'
  }
  const redacted = redactSecrets(text)
  if (redacted.length > maxChars) return clipString(redacted, maxChars)
  try {
    return JSON.parse(redacted)
  } catch {
    return redacted
  }
}

function clipString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`
}

/** Keys that must never be logged under any circumstances. */
const SECRET_KEYS = /^(authorization|api_key|apikey|token|cookie|set-cookie|x-api-key|x-engine-secret)$/i

export function redactHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return []
  return Object.keys(headers).map((k) => (SECRET_KEYS.test(k) ? `${k}=<redacted>` : k))
}

/** Secrets never reach error bodies, SSE, the callback or logs (SPEC §9.1, §12.1, §12.2). */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/("(?:api_?key|authorization|access_token|token)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
}

/**
 * Redacts the values of ALL query parameters (SPEC §4.1, §12.2): the query carries the
 * engine's run tokens and third-party secrets, such as session / app ids in callback and tool URLs.
 * Parameter names stay, so it is still clear what the URL is.
 */
export function safeUrl(url: string): string {
  try {
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url)
    const u = new URL(url, relative ? 'http://engine.local' : undefined)
    for (const key of [...new Set(u.searchParams.keys())]) u.searchParams.set(key, '<redacted>')
    return relative ? u.pathname + u.search : u.toString()
  } catch {
    return '<invalid-url>'
  }
}
