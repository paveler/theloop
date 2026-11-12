/**
 * Content classes and the field registry (SPEC §12.5).
 *
 * Every field an event writes to a sink (stdout, the memory journal, the disk journal, the
 * error webhook) is either safe metadata, a declared identifier, or belongs to a content
 * class. With LOG_CONTENT=all nothing here runs: output is as before. With any class excluded
 * (strict mode) every field goes through the registry: excluded classes are replaced or
 * dropped, and a string field the registry does not know is dropped and recorded as a miss —
 * the canary suite fails on any miss, so a new event cannot leak content unnoticed.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const CONTENT_CLASSES = ['prompt', 'messages', 'tools', 'model_names', 'external', 'meta', 'urls'] as const
export type ContentClass = (typeof CONTENT_CLASSES)[number]
export type ClassSet = ReadonlySet<ContentClass>

export const ALL_CLASSES: ClassSet = new Set(CONTENT_CLASSES)
export const NO_CLASSES: ClassSet = new Set()

export const OMITTED = '[omitted]'

/** contracts.ts PROVIDER_IDS, repeated here: contracts imports this module. */
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'glm', 'gigachat', 'minimax', 'kimi', 'openai-compatible', 'endpoint'] as const

export function isAllClasses(set: ClassSet): boolean {
  return set.size === CONTENT_CLASSES.length
}

/** `all` | `none` | comma list; throws on anything else (config and request validation). */
export function parseClasses(raw: string | readonly string[]): ClassSet {
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase()
    if (value === 'all') return ALL_CLASSES
    if (value === 'none' || value === '') return NO_CLASSES
    return parseClasses(value.split(',').map((s) => s.trim()).filter(Boolean))
  }
  const out = new Set<ContentClass>()
  for (const item of raw) {
    if (!(CONTENT_CLASSES as readonly string[]).includes(item)) {
      throw new Error(`unknown content class "${item}": one of ${CONTENT_CLASSES.join(', ')}, or all / none`)
    }
    out.add(item as ContentClass)
  }
  return out
}

export function intersectClasses(a: ClassSet, b: ClassSet): ClassSet {
  return new Set([...a].filter((c) => b.has(c)))
}

export function classList(set: ClassSet): ContentClass[] {
  return CONTENT_CLASSES.filter((c) => set.has(c))
}

/* ----------------------------------------------------------------- context */

/**
 * What one request / run may log. Created when POST /runs reads `logging`, bound to the run
 * id for the run's lifetime and its delivery job (SPEC §12.5).
 */
export interface LogContext {
  classes: ClassSet
  /** Tool, skill and fence names declared in the request: identifiers, safe in every mode. */
  declared: Set<string>
  /** Provider / caller call ids → engine-issued refs (`c1`, `c2`, …). */
  callRefs: Map<string, string>
}

export function newLogContext(classes: ClassSet, declared: Iterable<string> = []): LogContext {
  return { classes, declared: new Set(declared), callRefs: new Map() }
}

/** The request scope of POST /runs: validation warnings and the refusal see its context. */
export const requestLogContext = new AsyncLocalStorage<LogContext>()

/* ---------------------------------------------------------------- registry */

/**
 * - `safe` — engine-produced or harness-declared identifiers, codes, numbers, enums;
 * - `tool` — a tool / skill / fence name, or an array of them: declared → safe, else `model_names`;
 * - `call_id` — replaced by an engine ref; `drop` — never written in strict mode;
 * - `url` — origin only without `urls`; `meta` — values replaced without `meta`;
 * - `err` — an exception or network text: `external`; `stack` — omitted without `external`;
 * - a content class — the value goes or is replaced by the marker;
 * - a function — a custom rule for a composite value.
 */
type Rule =
  | 'safe'
  | 'tool'
  | 'call_id'
  | 'drop'
  | 'url'
  | 'meta'
  | 'err'
  | 'stack'
  | ContentClass
  | ((value: unknown, ctx: LogContext) => unknown)

/** Field name → rule, for every event. */
const FIELDS: Record<string, Rule> = {
  // identifiers and engine values
  run_id: 'safe',
  session_id: 'safe',
  idempotency_key: 'safe',
  history_revision: 'safe',
  operation_id: 'safe',
  step: 'safe',
  attempt: 'safe',
  attempts: 'safe',
  max_attempts: 'safe',
  provider: 'safe',
  endpoint: 'safe',
  model: 'safe',
  llm_chain: 'safe',
  from: 'safe',
  to: 'safe',
  llm_used: 'safe',
  // each entry carries the provider's error message
  llm_fallbacks: (value, ctx) =>
    Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === 'object' && 'error' in item
            ? { ...(item as object), error: errorObject((item as { error: unknown }).error, ctx) }
            : item,
        )
      : value,
  status: 'safe',
  http_status: 'safe',
  provider_status: 'safe',
  outcome: 'safe',
  reason: 'safe',
  finish_reason: 'safe',
  kind: 'safe',
  code: 'safe',
  retriable: 'safe',
  effect: 'safe',
  direction: 'safe',
  limit: 'safe',
  limits: 'safe',
  limit_from: 'safe',
  limit_to: 'safe',
  via: 'safe',
  by: 'safe',
  purpose: 'safe',
  target: 'safe',
  host: 'safe',
  wait: 'safe',
  cache: 'safe',
  history: 'safe',
  context_window: 'safe',
  context_tokens: 'safe',
  activation: 'safe',
  tool_search: 'safe',
  output_checks: 'safe',
  content_classes: 'safe',
  requested: 'safe',
  locale: 'safe',
  param: 'safe',
  dropped: 'safe',
  method: 'safe',
  path: 'safe',
  deleted: 'safe',
  expired: 'safe',
  pruned: 'safe',
  bytes: 'safe',
  bytes_before: 'safe',
  bytes_after: 'safe',
  retained: 'safe',
  active_runs: 'safe',
  signal: 'safe',
  last_event_id: 'safe',
  acked: 'safe',
  duplicate: 'safe',
  rejected: 'safe',
  is_error: 'safe',
  early: 'safe',
  throttle_key: 'safe',
  repair: 'safe',
  repair_attempt: 'safe',
  fence: 'tool',
  presentations_used: 'safe',
  max_presentations: 'safe',
  // tool / skill names
  tool: 'tool',
  tools: 'tool',
  tools_visible: 'tool',
  tool_calls: 'tool',
  skills: 'tool',
  name: 'tool',
  in_skills: (value, ctx) =>
    Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toolName(v, ctx)]))
            : toolName(item, ctx),
        )
      : value,
  empty_results: (value, ctx) =>
    value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [toolName(k, ctx), v]))
      : value,
  calls: (value, ctx) =>
    Array.isArray(value)
      ? value.map((item) => {
          if (typeof item !== 'string') return item
          const hash = item.lastIndexOf('#')
          return hash < 0 ? toolName(item, ctx) : `${toolName(item.slice(0, hash), ctx)}#${callRef(item.slice(hash + 1), ctx)}`
        })
      : value,
  // external identifiers
  call_id: 'call_id',
  provider_request_id: 'drop',
  // urls
  callback: 'url',
  url: 'url',
  // meta
  meta: 'meta',
  // exception and network text
  err: 'err',
  stack: 'stack',
  message: 'external',
  error_message: 'external',
  details: 'external',
  errors: 'external',
  error: 'external',
  // engine-written text: the i18n catalog, never model or caller text
  error_code: 'safe',
  retry_skipped: 'safe',
  dir: 'safe',
  answer_source: 'safe',
  limit_reached: 'safe',
  cost: 'safe',
  reasons: 'safe',
  event: 'safe',
  alert: 'safe',
  params: 'safe',
  public_url: 'safe',
  version: 'safe',
  provider_proxies: 'safe',
  provider_overrides: 'safe',
  endpoints: 'safe',
  private_cidrs: 'safe',
  http_hosts: 'safe',
  default_timezone: 'safe',
  port: 'safe',
  tls: 'safe',
  metrics: 'safe',
  public_providers: 'safe',
  context_window_default: 'safe',
  blocks: 'safe',
  // GigaChat file ids come from the provider
  files: 'safe',
  failed: 'safe',
}

/** Per-event overrides, `event.field`. */
const EVENT_FIELDS: Record<string, Rule> = {
  'tool_call.endpoint': 'url',
  'tool_result.error': 'tools',
  'output_check.errors': 'model_names',
  'tool_calls_sealed.reason': 'safe',
  // the provider's own words for why it dropped thinking blocks
  'thinking_blocks_dropped.reasons': 'external',
  // meta.locale as the caller sent it
  'locale_unsupported.requested': 'meta',
  // names of unknown params come from the request body
  'llm_params_unknown.params': 'external',
  // a refused body: the provider may be anything; keep only a known id
  'run_rejected.provider': (value) =>
    typeof value === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(value) ? value : OMITTED,
  // `invalid_tool_input: <reason>` quotes model output (an invented name, argument values)
  'tool_call_rejected.reason': (value, ctx) =>
    typeof value === 'string' && !(ctx.classes.has('model_names') && ctx.classes.has('tools'))
      ? value.split(':')[0]
      : value,
  // `name:effect[:deferred]`
  'run_start.tools': (value, ctx) =>
    Array.isArray(value)
      ? value.map((item) => {
          if (typeof item !== 'string') return item
          const [name = '', ...rest] = item.split(':')
          return [toolName(name, ctx), ...rest].join(':')
        })
      : value,
  'engine_listening.endpoint': 'safe',
  'run_start.limits': 'safe',
  'alert:callback_failed.callback': (value, ctx) => {
    if (!value || typeof value !== 'object') return value
    const cb = value as { url?: unknown; attempts?: unknown; last_error?: unknown }
    return {
      ...cb,
      url: applyRule('url', cb.url, ctx),
      last_error: applyRule('external', cb.last_error, ctx),
    }
  },
  'alert:run_failed.error': errorObject,
  'alert:run_crashed.error': errorObject,
  'alert:unhandled_error.error': errorObject,
}

function errorObject(value: unknown, ctx: LogContext): unknown {
  if (!value || typeof value !== 'object') return value
  const err = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(err)) out[k] = k === 'message' ? applyRule('external', v, ctx) : v
  return out
}

/** Content keys → rule. A content key not listed is dropped in strict mode. */
const CONTENT: Record<string, Rule> = {
  system: 'prompt',
  // already filtered by constituent when built (runs/messages.ts describeMessage)
  history_tail: (value, ctx) => (ctx.classes.has('messages') || ctx.classes.has('tools') ? value : undefined),
  text: 'messages',
  reasoning: 'messages',
  answer: 'messages',
  partial_text: 'messages',
  engine_note: 'messages',
  block: 'messages',
  draft: 'messages',
  issues: 'messages',
  args: 'tools',
  result: 'tools',
  body: 'tools',
  query: 'tools',
  error: 'tools',
  name: 'model_names',
  provider_body: 'external',
  tool_calls: (value, ctx) =>
    !ctx.classes.has('tools')
      ? undefined
      : Array.isArray(value)
      ? value.map((item) => {
          if (!item || typeof item !== 'object') return item
          const call = item as { call_id?: unknown; tool?: unknown; args?: unknown; invalid?: unknown }
          const out: Record<string, unknown> = {
            call_id: callRef(call.call_id, ctx),
            tool: toolName(call.tool, ctx),
          }
          out.args = call.args
          if (call.invalid !== undefined) out.invalid = applyRule('external', call.invalid, ctx)
          return out
        })
      : value,
}

/** Event-specific content overrides. */
const EVENT_CONTENT: Record<string, Rule> = {
  'tool_http.body': 'tools',
  'tool_protocol_error.body': 'tools',
  'provider_failure.provider_body': 'external',
  'run_done.provider_body': 'external',
}

/* ------------------------------------------------------------ the sanitizer */

let missHook: ((where: string) => void) | null = null

/** Tests: every unregistered field dropped in strict mode is reported here. */
export function onRegistryMiss(hook: ((where: string) => void) | null): void {
  missHook = hook
}

function containsString(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (Array.isArray(value)) return value.some(containsString)
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k.length > 0 && containsString(v))
  return false
}

const BUILTIN_NAMES = new Set(['load_skill', 'search_tools'])

export function toolName(value: unknown, ctx: LogContext): unknown {
  if (Array.isArray(value)) return value.map((v) => toolName(v, ctx))
  if (typeof value !== 'string') return value
  if (ctx.classes.has('model_names') || ctx.declared.has(value) || BUILTIN_NAMES.has(value)) return value
  return OMITTED
}

export function callRef(value: unknown, ctx: LogContext): unknown {
  if (typeof value !== 'string') return value
  let ref = ctx.callRefs.get(value)
  if (!ref) {
    ref = `c${ctx.callRefs.size + 1}`
    ctx.callRefs.set(value, ref)
  }
  return ref
}

/** scheme://host:port, nothing else. */
export function urlOrigin(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(value)
    if (relative) return OMITTED
    const u = new URL(value)
    return `${u.protocol}//${u.host}`
  } catch {
    return OMITTED
  }
}

function applyRule(rule: Rule, value: unknown, ctx: LogContext): unknown {
  if (value === undefined || value === null) return value
  if (typeof rule === 'function') return rule(value, ctx)
  switch (rule) {
    case 'safe':
      return value
    case 'tool':
      return toolName(value, ctx)
    case 'call_id':
      return callRef(value, ctx)
    case 'drop':
      return undefined
    case 'url':
      return ctx.classes.has('urls') ? value : Array.isArray(value) ? value.map(urlOrigin) : urlOrigin(value)
    case 'meta':
      if (ctx.classes.has('meta') || typeof value !== 'object' || Array.isArray(value)) {
        return ctx.classes.has('meta') ? value : OMITTED
      }
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k === 'session_id' ? v : OMITTED]),
      )
    case 'err':
      return ctx.classes.has('external') ? value : OMITTED
    case 'stack':
      return ctx.classes.has('external') ? value : undefined
    default:
      // a content class
      if (ctx.classes.has(rule)) return value
      return containsString(value) ? OMITTED : value
  }
}

/** Metadata of one event, strict mode. */
export function sanitizeFields(event: string, fields: Record<string, unknown>, ctx: LogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const rule = EVENT_FIELDS[`${event}.${key}`] ?? FIELDS[key]
    if (rule === undefined) {
      if (containsString(value)) {
        missHook?.(`${event}.${key}`)
        continue
      }
      out[key] = value
      continue
    }
    const next = applyRule(rule, value, ctx)
    if (next !== undefined) out[key] = next
  }
  return out
}

/** Content of one event, strict mode: excluded keys are absent, not marked. */
export function sanitizeContent(
  event: string,
  content: Record<string, unknown>,
  ctx: LogContext,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined) continue
    const rule = EVENT_CONTENT[`${event}.${key}`] ?? CONTENT[key]
    if (rule === undefined) {
      missHook?.(`${event}.content.${key}`)
      continue
    }
    if (typeof rule === 'string' && (CONTENT_CLASSES as readonly string[]).includes(rule)) {
      if (ctx.classes.has(rule as ContentClass)) out[key] = value
      continue
    }
    const next = applyRule(rule, value, ctx)
    if (next !== undefined) out[key] = next
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** How describeMessage renders a history message for the journal in strict mode. */
export interface DescribeView {
  keep: (cls: ContentClass) => boolean
  ref: (callId: string) => string
  tool: (name: string) => string
}

export function describeView(ctx: LogContext): DescribeView | undefined {
  if (isAllClasses(ctx.classes)) return undefined
  return {
    keep: (cls) => ctx.classes.has(cls),
    ref: (callId) => String(callRef(callId, ctx)),
    tool: (name) => String(toolName(name, ctx)),
  }
}
