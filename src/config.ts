/**
 * Configuration from env (SPEC §14). Values are read once at startup;
 * tests build their own Config via createConfig(env) and pass it to createEngine.
 */
import { PROVIDER_IDS, type ProviderId } from './contracts.js'
import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from './i18n.js'
import type { ThrottleSettings } from './providers/throttle.js'

/** Header carrying the engine secret from env CALLBACK_SECRET: callback (SPEC §7) and error webhook (§12.3). */
export const ENGINE_SECRET_HEADER = 'X-Engine-Secret'

export interface Config {
  port: number
  publicUrl: string
  engineTokens: string[]
  allowedOrigins: string[]

  egressAllowlist: string[]
  allowInsecureEgress: boolean

  maxConcurrentRuns: number
  maxRequestBytes: number
  toolResponseMaxBytes: number
  sseBufferMaxBytes: number
  runRetentionMs: number
  runRetentionUnackedMs: number
  maxRetainedRuns: number
  maxRetainedBytes: number
  callbackAttemptTimeoutMs: number
  /** Secret the engine signs callbacks with: the X-Engine-Secret header (SPEC §7). */
  callbackSecret: string | undefined
  /** Where engine errors are sent (SPEC §12.3); empty — webhook off. */
  errorWebhookUrl: string | undefined
  imageMaxBytes: number
  shutdownGraceMs: number
  maxContextFallback: number
  /** Locale of engine text when the request has no meta.locale (SPEC Appendix B). */
  engineLocale: Locale
  /** Time zone of dates for the model when the request has no meta.timezone (SPEC §9.4). */
  defaultTimezone: string

  logLevel: string
  /** Event content (prompt, texts, tool args / results) to stdout as well — local only. */
  logPrompts: boolean
  /** In-memory journal for GET /logs (SPEC §12.4); 0 entries — off. */
  logBufferMaxEntries: number
  logBufferMaxBytes: number
  /** Event content in the journal; on by default. */
  logBufferContent: boolean
  logContentMaxChars: number
  /** The journal on disk (SPEC §12.4); unset — memory only. */
  logDir: string | undefined
  /** Day files older than this are deleted; 0 — today only. */
  logRetentionDays: number
  logDirMaxBytes: number
  /** Per-field content cap on disk: a safety net, not a trim. */
  logDiskContentMaxChars: number

  /** Queue and AIMD concurrency ceiling per provider key (SPEC §11.6). */
  providerThrottle: ThrottleSettings
  /** Retries on 429 (SPEC §11.3): count, base and ceiling of the full-jitter backoff. */
  rateLimitRetries: number
  rateLimitBackoffMs: number
  rateLimitMaxDelayMs: number

  providerKeys: Record<string, string | undefined>
  /** Proxies for named providers from <PROVIDER>_PROXY_URL (SPEC §11.4); login / password go in the URL. */
  providerProxies: Partial<Record<ProviderId, string>>
  gigachatScope: string
}

type Env = Record<string, string | undefined>

function num(env: Env, key: string, def: number): number {
  const raw = env[key]
  if (raw == null || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`env ${key}: not a number (${raw})`)
  return n
}

function list(env: Env, key: string, def: string[] = []): string[] {
  const raw = env[key]
  if (raw == null || raw === '') return def
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function bool(env: Env, key: string, def = false): boolean {
  const raw = env[key]
  if (raw == null || raw === '') return def
  return raw === '1' || raw.toLowerCase() === 'true'
}

/** Integer ≥ min, otherwise the engine does not start: a broken limit is worse than a missing one. */
function int(env: Env, key: string, def: number, min: number): number {
  const n = num(env, key, def)
  if (!Number.isInteger(n) || n < min) throw new Error(`env ${key}: must be an integer ≥ ${min} (${env[key]})`)
  return n
}

/** Concurrency ceiling per provider: PROVIDER_MAX_CONCURRENCY_<PROVIDER>, else _DEFAULT (SPEC §11.6). */
const CONCURRENCY_DEFAULTS: Partial<Record<ProviderId, number>> = {
  // GigaChat was observed returning 429 at 16 concurrent calls, not at 8
  gigachat: 6,
  // z.ai limits concurrency by account plan: 429 already at 5+, AIMD dropped
  // the ceiling to 1. On a higher plan, raise PROVIDER_MAX_CONCURRENCY_GLM
  glm: 4,
}

function maxConcurrency(env: Env): Record<ProviderId, number> {
  const fallback = int(env, 'PROVIDER_MAX_CONCURRENCY_DEFAULT', 16, 1)
  const out = {} as Record<ProviderId, number>
  for (const provider of PROVIDER_IDS) {
    const key = `PROVIDER_MAX_CONCURRENCY_${provider.toUpperCase().replace(/-/g, '_')}`
    out[provider] = int(env, key, CONCURRENCY_DEFAULTS[provider] ?? fallback, 1)
  }
  return out
}

/** Proxy env per provider (SPEC §11.4); openai-compatible has no proxy, base_url comes from the request. */
const PROXY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_PROXY_URL',
  openai: 'OPENAI_PROXY_URL',
  deepseek: 'DEEPSEEK_PROXY_URL',
  glm: 'GLM_PROXY_URL',
  gigachat: 'GIGACHAT_PROXY_URL',
  minimax: 'MINIMAX_PROXY_URL',
  kimi: 'KIMI_PROXY_URL',
}

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:'])

/** A broken proxy stops the engine at startup; the value never goes into the error (it may hold a password). */
function providerProxies(env: Env): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {}
  for (const [provider, key] of Object.entries(PROXY_ENV) as Array<[ProviderId, string]>) {
    const raw = env[key]?.trim()
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`env ${key}: invalid URL`)
    }
    if (!PROXY_PROTOCOLS.has(url.protocol)) {
      throw new Error(`env ${key}: scheme ${url.protocol} is not supported — use http, https or socks5`)
    }
    out[provider] = raw
  }
  return out
}

/** Proxies for the log: host:port only, no login or password. */
export function describeProxies(config: Config): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [provider, raw] of Object.entries(config.providerProxies)) {
    const url = new URL(raw)
    out[provider] = `${url.protocol}//${url.host}`
  }
  return out
}

function engineLocale(env: Env): Locale {
  const raw = env.ENGINE_LOCALE?.trim()
  if (!raw) return DEFAULT_LOCALE
  if (!isLocale(raw)) throw new Error(`env ENGINE_LOCALE: one of ${LOCALES.join(', ')} (${raw})`)
  return raw
}

/** Time zone when neither meta.timezone nor DEFAULT_TIMEZONE is set (SPEC §9.4). */
export const DEFAULT_TIMEZONE = 'UTC'

/** An invalid zone stops the engine at startup. */
function defaultTimezone(env: Env): string {
  const raw = env.DEFAULT_TIMEZONE?.trim()
  if (!raw) return DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw })
  } catch {
    throw new Error(`env DEFAULT_TIMEZONE: unknown IANA time zone (${raw})`)
  }
  return raw
}

/**
 * ENGINE_TOKEN is required, there is no default (SPEC §4.1): the engine does not start without it.
 */
export function createConfig(env: Env = process.env): Config {
  const engineTokens = list(env, 'ENGINE_TOKEN')
  if (engineTokens.length === 0) {
    throw new Error('ENGINE_TOKEN is required (SPEC §4.1), there is no default')
  }

  const port = num(env, 'PORT', 8080)
  const rateLimitMaxDelayMs = int(env, 'PROVIDER_RATE_LIMIT_MAX_DELAY_MS', 16_000, 0)

  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    engineTokens,
    allowedOrigins: list(env, 'ALLOWED_ORIGINS'),

    egressAllowlist: list(env, 'EGRESS_ALLOWLIST'),
    allowInsecureEgress: bool(env, 'ALLOW_INSECURE_EGRESS'),

    maxConcurrentRuns: num(env, 'MAX_CONCURRENT_RUNS', 32),
    maxRequestBytes: num(env, 'MAX_REQUEST_BYTES', 1_048_576),
    toolResponseMaxBytes: num(env, 'TOOL_RESPONSE_MAX_BYTES', 1_048_576),
    sseBufferMaxBytes: num(env, 'SSE_BUFFER_MAX_BYTES', 2_097_152),
    runRetentionMs: num(env, 'RUN_RETENTION_MS', 600_000),
    runRetentionUnackedMs: num(env, 'RUN_RETENTION_UNACKED_MS', 3_600_000),
    maxRetainedRuns: num(env, 'MAX_RETAINED_RUNS', 1000),
    maxRetainedBytes: num(env, 'MAX_RETAINED_BYTES', 268_435_456),
    callbackAttemptTimeoutMs: num(env, 'CALLBACK_ATTEMPT_TIMEOUT_MS', 10_000),
    callbackSecret: env.CALLBACK_SECRET?.trim() || undefined,
    errorWebhookUrl: env.ERROR_WEBHOOK_URL?.trim() || undefined,
    imageMaxBytes: num(env, 'IMAGE_MAX_BYTES', 5_242_880),
    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 7_000),
    maxContextFallback: num(env, 'MAX_CONTEXT_FALLBACK', 128_000),
    engineLocale: engineLocale(env),
    defaultTimezone: defaultTimezone(env),

    logLevel: env.LOG_LEVEL ?? 'info',
    logPrompts: bool(env, 'LOG_PROMPTS'),
    logBufferMaxEntries: num(env, 'LOG_BUFFER_MAX_ENTRIES', 20_000),
    logBufferMaxBytes: num(env, 'LOG_BUFFER_MAX_BYTES', 33_554_432),
    logBufferContent: bool(env, 'LOG_BUFFER_CONTENT', true),
    logContentMaxChars: num(env, 'LOG_CONTENT_MAX_CHARS', 4000),
    logDir: env.LOG_DIR?.trim() || undefined,
    logRetentionDays: int(env, 'LOG_RETENTION_DAYS', 7, 0),
    logDirMaxBytes: num(env, 'LOG_DIR_MAX_BYTES', 2_147_483_648),
    logDiskContentMaxChars: num(env, 'LOG_DISK_CONTENT_MAX_CHARS', 200_000),

    providerThrottle: {
      enabled: bool(env, 'PROVIDER_THROTTLE', true),
      maxConcurrency: maxConcurrency(env),
      queueTimeoutMs: int(env, 'PROVIDER_QUEUE_TIMEOUT_MS', 60_000, 0),
      cooldownMs: int(env, 'PROVIDER_THROTTLE_COOLDOWN_MS', 1_000, 0),
      maxCooldownMs: rateLimitMaxDelayMs,
      increaseAfter: int(env, 'PROVIDER_THROTTLE_INCREASE_AFTER', 10, 1),
    },
    rateLimitRetries: int(env, 'PROVIDER_RATE_LIMIT_RETRIES', 5, 0),
    rateLimitBackoffMs: int(env, 'PROVIDER_RATE_LIMIT_BACKOFF_MS', 1_000, 0),
    rateLimitMaxDelayMs,

    providerKeys: {
      anthropic: env.ANTHROPIC_API_KEY,
      openai: env.OPENAI_API_KEY,
      deepseek: env.DEEPSEEK_API_KEY,
      glm: env.GLM_API_KEY,
      gigachat: env.GIGACHAT_AUTH_KEY,
      minimax: env.MINIMAX_API_KEY,
      kimi: env.KIMI_API_KEY,
    },
    providerProxies: providerProxies(env),
    gigachatScope: env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS',
  }
}
