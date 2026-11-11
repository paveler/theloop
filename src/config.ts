/**
 * Configuration from env (SPEC §14). Values are read once at startup;
 * tests build their own Config via createConfig(env) and pass it to createEngine.
 */
import { PROVIDER_IDS, type ProviderId } from './contracts.js'
import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from './i18n.js'
import type { ThrottleSettings } from './providers/throttle.js'
import { NO_CLASSES, parseClasses, type ClassSet } from './log-policy.js'
import { readFileSync } from 'node:fs'
import { parseCidrList, type Cidr } from './egress/cidr.js'

/** Header carrying the engine secret from env CALLBACK_SECRET: callback (SPEC §7) and error webhook (§12.3). */
export const ENGINE_SECRET_HEADER = 'X-Engine-Secret'

export interface Config {
  port: number
  publicUrl: string
  engineTokens: string[]
  allowedOrigins: string[]

  egressAllowlist: string[]
  allowInsecureEgress: boolean
  /** Private ranges egress may reach (SPEC §11.4); [] — none, as before. */
  egressPrivateCidrs: Cidr[]
  /** Hosts reachable over plain http (allowlist syntax, optional port). */
  egressHttpHosts: string[]
  /** Built-in public provider hosts allowed; 0 — closed network (SPEC §11.4). */
  egressPublicProviders: boolean
  /** <PROVIDER>_BASE_URL: an on-prem installation or a gateway of a named provider (SPEC §9.1). */
  providerBaseUrls: Partial<Record<ProviderId, string>>
  /** GIGACHAT_OAUTH_URL, set together with GIGACHAT_BASE_URL. */
  gigachatOAuthUrl: string | undefined
  /** Operator-defined model endpoints by request name (SPEC §9.1). */
  endpoints: Record<string, EndpointConfig>
  /** GET /metrics Bearer token; unset — /metrics is off (SPEC §4.10). */
  metricsToken: string | undefined
  metricsMaxModels: number
  /** 0 — unauthenticated /health answers ok / shutting_down only (SPEC §4.7). */
  healthDetails: boolean

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
  /** Content classes written to logs (SPEC §12.5): all by default; LOG_BUFFER_CONTENT=0 is none. */
  logContent: ClassSet
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

/** An operator-defined model server (SPEC §9.1, LLM_ENDPOINT_<NAME>_*). */
export interface EndpointConfig {
  /** Request name: lowercased, `_` → `-`. */
  name: string
  url: string
  kind: 'openai' | 'anthropic'
  apiKey: string | undefined
  contextWindow: number | undefined
  maxTokens: number
  parallelTools: boolean
  usageInStream: boolean
  toolChoiceNone: boolean
  thinking: 'off' | 'effort' | 'budget' | 'adaptive'
  reasoning: 'signed' | 'unsigned'
  reasoningReplay: 'none' | 'reasoning' | 'reasoning_content'
  prefixBinding: boolean
  maxConcurrency: number
  concurrencyScope: 'endpoint' | 'key'
}

/**
 * A secret from env or from the file its `_FILE` twin names (SPEC §14): both set or an
 * unreadable / empty file stops the engine; the path may be in the error, the content never.
 */
function secret(env: Env, key: string): string | undefined {
  const fileKey = `${key}_FILE`
  const direct = env[key]
  const file = env[fileKey]?.trim()
  if (file && direct != null && direct !== '') throw new Error(`env ${key} and ${fileKey} are both set: use one`)
  if (!file) return direct
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`env ${fileKey}: cannot read ${file}`)
  }
  const value = text.replace(/\r?\n$/, '')
  if (value.trim() === '') throw new Error(`env ${fileKey}: ${file} is empty`)
  return value
}

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
    const raw = secret(env, key)?.trim()
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

/** Base URL env per named provider (SPEC §9.1); openai-compatible takes base_url from the request. */
const BASE_URL_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
  glm: 'GLM_BASE_URL',
  gigachat: 'GIGACHAT_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  kimi: 'KIMI_BASE_URL',
}

/**
 * An operator-set URL (overrides, endpoints): http / https, no credentials, plain http only for
 * a host in EGRESS_HTTP_HOSTS (SPEC §11.4). Invalid → the engine does not start.
 */
function operatorUrl(key: string, raw: string, httpHosts: readonly string[]): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`env ${key}: invalid URL`)
  }
  if (url.username || url.password) throw new Error(`env ${key}: credentials in the URL are not allowed`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`env ${key}: scheme ${url.protocol} — use https or http`)
  if (url.protocol === 'http:') {
    const port = url.port ? Number(url.port) : 80
    if (!hostMatches(url.hostname, httpHosts, port)) {
      throw new Error(`env ${key}: plain http needs the host in EGRESS_HTTP_HOSTS (${url.host})`)
    }
  }
  return raw.replace(/\/+$/, '')
}

/** The allowlist matcher without importing the egress client (it imports this module). */
function hostMatches(hostname: string, entries: readonly string[], port: number): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return entries.some((raw) => {
    let entry = raw.trim().toLowerCase()
    let entryPort: number | null = null
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    if (bracket) {
      entry = bracket[1]!
      entryPort = bracket[2] ? Number(bracket[2]) : null
    } else if (entry.split(':').length === 2 && /:\d+$/.test(entry)) {
      entryPort = Number(entry.split(':')[1])
      entry = entry.split(':')[0]!
    }
    if (entryPort != null && entryPort !== port) return false
    return entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry
  })
}

function providerBaseUrls(
  env: Env,
  httpHosts: readonly string[],
  proxies: Partial<Record<ProviderId, string>>,
): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {}
  for (const [provider, key] of Object.entries(BASE_URL_ENV) as Array<[ProviderId, string]>) {
    const raw = env[key]?.trim()
    if (!raw) continue
    // a proxy sees no DNS answer, so the private-range rules could not hold (SPEC §11.4)
    if (proxies[provider]) throw new Error(`env ${key} and ${PROXY_ENV[provider]}: a proxy cannot be combined with a base URL override`)
    out[provider] = operatorUrl(key, raw, httpHosts)
  }
  return out
}

const ENDPOINT_SUFFIXES = [
  'URL',
  'KIND',
  'API_KEY',
  'API_KEY_FILE',
  'CONTEXT_WINDOW',
  'MAX_TOKENS',
  'PARALLEL_TOOLS',
  'USAGE_IN_STREAM',
  'TOOL_CHOICE_NONE',
  'THINKING',
  'REASONING',
  'REASONING_REPLAY',
  'PREFIX_BINDING',
  'MAX_CONCURRENCY',
  'CONCURRENCY_SCOPE',
].sort((a, b) => b.length - a.length)

function oneOf<T extends string>(key: string, raw: string | undefined, allowed: readonly T[], def: T): T {
  const value = raw?.trim()
  if (!value) return def
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`env ${key}: one of ${allowed.join(', ')} (${value})`)
  return value as T
}

/** LLM_ENDPOINT_<NAME>_* (SPEC §9.1). */
function endpoints(env: Env, httpHosts: readonly string[]): Record<string, EndpointConfig> {
  const names = new Set<string>()
  for (const key of Object.keys(env)) {
    if (!key.startsWith('LLM_ENDPOINT_') || env[key] == null || env[key] === '') continue
    const rest = key.slice('LLM_ENDPOINT_'.length)
    const suffix = ENDPOINT_SUFFIXES.find((s) => rest.endsWith(`_${s}`))
    if (!suffix) throw new Error(`env ${key}: unknown endpoint setting`)
    const name = rest.slice(0, -suffix.length - 1)
    if (!/^[A-Z0-9_]+$/.test(name)) throw new Error(`env ${key}: endpoint name must be [A-Z0-9_]+`)
    names.add(name)
  }
  const out: Record<string, EndpointConfig> = {}
  const fallback = int(env, 'PROVIDER_MAX_CONCURRENCY_DEFAULT', 16, 1)
  for (const envName of names) {
    const p = `LLM_ENDPOINT_${envName}_`
    const name = envName.toLowerCase().replace(/_/g, '-')
    if (out[name]) throw new Error(`env ${p}*: endpoint name "${name}" is defined twice`)
    const rawUrl = env[`${p}URL`]?.trim()
    if (!rawUrl) throw new Error(`env ${p}URL is required`)
    const kind = oneOf(`${p}KIND`, env[`${p}KIND`], ['openai', 'anthropic'] as const, 'openai')
    const reasoning = oneOf(`${p}REASONING`, env[`${p}REASONING`], ['signed', 'unsigned'] as const, 'signed')
    const prefixBinding = bool(env, `${p}PREFIX_BINDING`)
    if (prefixBinding && (kind !== 'anthropic' || reasoning !== 'signed')) {
      throw new Error(`env ${p}PREFIX_BINDING: only for KIND=anthropic with REASONING=signed`)
    }
    const replay = oneOf(
      `${p}REASONING_REPLAY`,
      env[`${p}REASONING_REPLAY`],
      ['none', 'reasoning', 'reasoning_content'] as const,
      'none',
    )
    if (kind !== 'openai' && env[`${p}REASONING_REPLAY`]?.trim()) {
      throw new Error(`env ${p}REASONING_REPLAY: only for KIND=openai`)
    }
    const contextWindow = env[`${p}CONTEXT_WINDOW`]?.trim() ? int(env, `${p}CONTEXT_WINDOW`, 0, 1) : undefined
    out[name] = {
      name,
      url: operatorUrl(`${p}URL`, rawUrl, httpHosts),
      kind,
      apiKey: secret(env, `${p}API_KEY`)?.trim() || undefined,
      contextWindow,
      maxTokens: int(env, `${p}MAX_TOKENS`, 32_000, 1),
      parallelTools: bool(env, `${p}PARALLEL_TOOLS`),
      usageInStream: bool(env, `${p}USAGE_IN_STREAM`),
      toolChoiceNone: bool(env, `${p}TOOL_CHOICE_NONE`, true),
      thinking: oneOf(
        `${p}THINKING`,
        env[`${p}THINKING`],
        ['off', 'effort', 'budget', 'adaptive'] as const,
        kind === 'anthropic' ? 'budget' : 'effort',
      ),
      reasoning,
      reasoningReplay: kind === 'openai' ? replay : 'none',
      prefixBinding,
      maxConcurrency: int(env, `${p}MAX_CONCURRENCY`, fallback, 1),
      concurrencyScope: oneOf(`${p}CONCURRENCY_SCOPE`, env[`${p}CONCURRENCY_SCOPE`], ['endpoint', 'key'] as const, 'endpoint'),
    }
  }
  return out
}

/** Overrides and endpoints for the log: scheme and host:port, never a key. */
export function describeOverrides(config: Config): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [provider, raw] of Object.entries(config.providerBaseUrls)) {
    const url = new URL(raw)
    out[provider] = `${url.protocol}//${url.host}`
  }
  if (config.gigachatOAuthUrl) {
    const url = new URL(config.gigachatOAuthUrl)
    out['gigachat-oauth'] = `${url.protocol}//${url.host}`
  }
  return out
}

export function describeEndpoints(config: Config): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of Object.values(config.endpoints)) {
    const url = new URL(e.url)
    out[e.name] = `${e.kind} ${url.protocol}//${url.host}`
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

/** LOG_CONTENT, with LOG_BUFFER_CONTENT=0 as an alias of `none` (SPEC §12.5). */
function logContent(env: Env): ClassSet {
  const legacyOff = env.LOG_BUFFER_CONTENT != null && env.LOG_BUFFER_CONTENT !== '' && !bool(env, 'LOG_BUFFER_CONTENT')
  const raw = env.LOG_CONTENT?.trim()
  let classes: ClassSet
  try {
    classes = raw ? parseClasses(raw) : legacyOff ? NO_CLASSES : parseClasses('all')
  } catch (err) {
    throw new Error(`env LOG_CONTENT: ${(err as Error).message}`)
  }
  if (legacyOff && raw && classes.size > 0) {
    throw new Error('env LOG_BUFFER_CONTENT=0 is an alias of LOG_CONTENT=none: they conflict')
  }
  return classes
}

/**
 * ENGINE_TOKEN is required, there is no default (SPEC §4.1): the engine does not start without it.
 */
export function createConfig(env: Env = process.env): Config {
  const engineTokens = list({ ENGINE_TOKEN: secret(env, 'ENGINE_TOKEN') }, 'ENGINE_TOKEN')
  if (engineTokens.length === 0) {
    throw new Error('ENGINE_TOKEN is required (SPEC §4.1), there is no default')
  }

  const port = num(env, 'PORT', 8080)
  const egressHttpHosts = list(env, 'EGRESS_HTTP_HOSTS')
  const proxies = providerProxies(env)
  const baseUrls = providerBaseUrls(env, egressHttpHosts, proxies)
  const gigachatOAuthUrl = env.GIGACHAT_OAUTH_URL?.trim()
    ? operatorUrl('GIGACHAT_OAUTH_URL', env.GIGACHAT_OAUTH_URL.trim(), egressHttpHosts)
    : undefined
  if (Boolean(baseUrls.gigachat) !== Boolean(gigachatOAuthUrl)) {
    throw new Error('env GIGACHAT_BASE_URL and GIGACHAT_OAUTH_URL go together: set both or neither')
  }
  const errorWebhookUrl = env.ERROR_WEBHOOK_URL?.trim() || undefined
  if (errorWebhookUrl) {
    try {
      const u = new URL(errorWebhookUrl)
      if (u.username || u.password) throw new Error('credentials')
    } catch {
      throw new Error('env ERROR_WEBHOOK_URL: invalid URL or credentials in it')
    }
  }
  const rateLimitMaxDelayMs = int(env, 'PROVIDER_RATE_LIMIT_MAX_DELAY_MS', 16_000, 0)

  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    engineTokens,
    allowedOrigins: list(env, 'ALLOWED_ORIGINS'),

    egressAllowlist: list(env, 'EGRESS_ALLOWLIST'),
    allowInsecureEgress: bool(env, 'ALLOW_INSECURE_EGRESS'),
    egressPrivateCidrs: parseCidrList(env.EGRESS_PRIVATE_CIDRS),
    egressHttpHosts,
    egressPublicProviders: bool(env, 'EGRESS_PUBLIC_PROVIDERS', true),
    providerBaseUrls: baseUrls,
    gigachatOAuthUrl,
    endpoints: endpoints(env, egressHttpHosts),
    metricsToken: secret(env, 'METRICS_TOKEN')?.trim() || undefined,
    metricsMaxModels: int(env, 'METRICS_MAX_MODELS', 50, 1),
    healthDetails: bool(env, 'HEALTH_DETAILS', true),

    maxConcurrentRuns: num(env, 'MAX_CONCURRENT_RUNS', 32),
    maxRequestBytes: num(env, 'MAX_REQUEST_BYTES', 1_048_576),
    toolResponseMaxBytes: num(env, 'TOOL_RESPONSE_MAX_BYTES', 1_048_576),
    sseBufferMaxBytes: num(env, 'SSE_BUFFER_MAX_BYTES', 2_097_152),
    runRetentionMs: num(env, 'RUN_RETENTION_MS', 600_000),
    runRetentionUnackedMs: num(env, 'RUN_RETENTION_UNACKED_MS', 3_600_000),
    maxRetainedRuns: num(env, 'MAX_RETAINED_RUNS', 1000),
    maxRetainedBytes: num(env, 'MAX_RETAINED_BYTES', 268_435_456),
    callbackAttemptTimeoutMs: num(env, 'CALLBACK_ATTEMPT_TIMEOUT_MS', 10_000),
    callbackSecret: secret(env, 'CALLBACK_SECRET')?.trim() || undefined,
    errorWebhookUrl,
    imageMaxBytes: num(env, 'IMAGE_MAX_BYTES', 5_242_880),
    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 7_000),
    maxContextFallback: num(env, 'MAX_CONTEXT_FALLBACK', 128_000),
    engineLocale: engineLocale(env),
    defaultTimezone: defaultTimezone(env),

    logLevel: env.LOG_LEVEL ?? 'info',
    logPrompts: bool(env, 'LOG_PROMPTS'),
    logBufferMaxEntries: num(env, 'LOG_BUFFER_MAX_ENTRIES', 20_000),
    logBufferMaxBytes: num(env, 'LOG_BUFFER_MAX_BYTES', 33_554_432),
    logContent: logContent(env),
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
      anthropic: secret(env, 'ANTHROPIC_API_KEY'),
      openai: secret(env, 'OPENAI_API_KEY'),
      deepseek: secret(env, 'DEEPSEEK_API_KEY'),
      glm: secret(env, 'GLM_API_KEY'),
      gigachat: secret(env, 'GIGACHAT_AUTH_KEY'),
      minimax: secret(env, 'MINIMAX_API_KEY'),
      kimi: secret(env, 'KIMI_API_KEY'),
    },
    providerProxies: proxies,
    gigachatScope: env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS',
  }
}
