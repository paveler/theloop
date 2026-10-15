/**
 * Logs (SPEC §12.2, §12.4): pino to stdout + an in-memory journal for GET /logs.
 *
 * An event = metadata + optional content (prompt, model texts, tool args /
 * results). Metadata goes to stdout and the journal, with run_id on every line that has one.
 * content goes only to the journal (LOG_BUFFER_CONTENT, on by default), to stdout only
 * with LOG_PROMPTS=1 (local). Every content field is clipped to LOG_CONTENT_MAX_CHARS.
 * Keys and header values are never written anywhere.
 */
import pino from 'pino'
import type { Config } from './config.js'
import { LogBuffer, type LogLevel } from './log-buffer.js'

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
>

let root: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
let buffer = new LogBuffer(20_000, 33_554_432)
let contentToBuffer = true
let contentToStdout = false
let contentMaxChars = 4000

export function initLogger(settings: LogSettings): Logger {
  root = pino({ level: settings.logLevel })
  buffer = new LogBuffer(settings.logBufferMaxEntries, settings.logBufferMaxBytes)
  contentToBuffer = settings.logBufferContent
  contentToStdout = settings.logPrompts
  contentMaxChars = settings.logContentMaxChars
  return root
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
  const clipped =
    content && (contentToBuffer || contentToStdout) ? clipContent(content, contentMaxChars) : undefined
  root[level](contentToStdout && clipped ? { ...fields, content: clipped } : fields, event)
  buffer.push(level, event, fields, contentToBuffer ? clipped : undefined)
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
