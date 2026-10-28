/**
 * API and message format contracts (SPEC §4, §5, §6, §7, §8, §10).
 * Everything that comes from outside goes through zod; engine types are derived from here.
 */
import { z } from 'zod'

export const CONTRACT_VERSION = '1'

/* ---------------------------------------------------------------- messages */

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ImagePartSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
})

export const EventPartSchema = z.object({
  type: z.literal('event'),
  name: z.string(),
  data: z.unknown().optional(),
})

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  EventPartSchema,
])

export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  call_id: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown(),
  operation_id: z.string().nullish(),
})

/** reasoning: text may be absent, provider_metadata is opaque (SPEC §5.2). */
export const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string().optional(),
  provider: z.string().min(1),
  provider_metadata: z.record(z.string(), z.unknown()).default({}),
})

export const AssistantPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  ReasoningPartSchema,
])

/** Service fields of engine messages (SPEC §5): run_id, seq, created_at. */
const MessageEnvelope = {
  run_id: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  created_at: z.string().optional(),
  id: z.string().optional(), // the harness's own record id — ignored by the engine
}

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.array(ContentPartSchema).min(1),
  ...MessageEnvelope,
})

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(AssistantPartSchema),
  partial: z.literal(true).optional(),
  ...MessageEnvelope,
})

export const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  call_id: z.string().min(1),
  tool: z.string().min(1),
  result: z.unknown().optional(),
  error: z.string().optional(),
  is_error: z.boolean(),
  operation_id: z.string().nullish(),
  truncated: z.boolean().optional(),
  /**
   * Written by the engine for its own tools (§6.8); the only mark of a built-in result. Only
   * `true` counts: a harness that stores the column as false / null on HTTP tool messages is fine.
   */
  builtin: z.boolean().nullish(),
  ...MessageEnvelope,
})

export const StoredMessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
])

export type TextPart = z.infer<typeof TextPartSchema>
export type ImagePart = z.infer<typeof ImagePartSchema>
export type EventPart = z.infer<typeof EventPartSchema>
export type ContentPart = z.infer<typeof ContentPartSchema>
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type AssistantPart = z.infer<typeof AssistantPartSchema>
export type UserMessage = z.infer<typeof UserMessageSchema>
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>
export type ToolMessage = z.infer<typeof ToolMessageSchema>
export type StoredMessage = z.infer<typeof StoredMessageSchema>

/* ------------------------------------------------------------------ limits */

/** Defaults and server ceilings — SPEC §10. A request can only tighten them. */
export const LIMIT_DEFAULTS = {
  max_steps: 8,
  max_tokens: 4096,
  max_tool_calls: 16,
  max_total_tokens: 200_000,
  timeout_ms: 120_000,
  tool_result_max_bytes: 32_768,
} as const

export const LIMIT_CAPS = {
  max_steps: 32,
  max_tool_calls: 64,
  max_repeated_calls: 3,
  max_total_tokens: 1_000_000,
  timeout_ms: 600_000,
  tool_result_max_bytes: 262_144,
  tool_timeout_ms: 300_000,
} as const

export const TOOL_TIMEOUT_DEFAULT_MS = 30_000

export const LimitsSchema = z
  .object({
    max_steps: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().nonnegative().optional(),
    max_total_tokens: z.number().int().positive().optional(),
    max_cost: z.number().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    tool_result_max_bytes: z.number().int().positive().optional(),
    /** false — the pre-1.2 behavior: max_steps / max_tool_calls end the run without an answer (SPEC §10.1). */
    final_answer: z.boolean().optional(),
    /** Repeats tolerated before tools are disabled (SPEC §6.7); default 1, clamped to 3. */
    max_repeated_calls: z.number().int().nonnegative().optional(),
    /** Presentations reaching the user per run (SPEC §6.9); absent — no limit. */
    max_presentations: z.number().int().positive().optional(),
  })
  .default({})

export type LimitsInput = z.infer<typeof LimitsSchema>

export interface Limits {
  max_steps: number
  max_tokens: number
  max_tool_calls: number
  max_total_tokens: number
  max_cost?: number
  timeout_ms: number
  tool_result_max_bytes: number
  /** A text-only last step on max_steps / max_tool_calls (SPEC §10.1). */
  final_answer: boolean
  max_repeated_calls: number
  max_presentations?: number
}

/** The limits that end in a text-only final step instead of a run without an answer (SPEC §10.1). */
export type FinalAnswerLimit = 'max_steps' | 'max_tool_calls'

/* -------------------------------------------------------------------- llm */

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'deepseek',
  'glm',
  'gigachat',
  'minimax',
  'openai-compatible',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/** GigaChat scope: individual / business pay-as-you-go / business under contract (SPEC §9.1). */
export const GIGACHAT_SCOPES = ['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP'] as const

export const PricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().default(0),
  cache_write: z.number().nonnegative().default(0),
  per_tokens: z.number().positive().default(1_000_000),
  currency: z.string().default('USD'),
  version: z.string().optional(),
})

export type Pricing = z.infer<typeof PricingSchema>

export const CapabilitiesOverrideSchema = z.object({
  parallel_tools: z.boolean().optional(),
  usage_in_stream: z.boolean().optional(),
})

export const LlmParamsSchema = z
  .object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
    thinking: z.object({ budget_tokens: z.number().int().positive() }).optional(),
    cache: z.boolean().optional(),
  })
  .loose() // unknown ones — warn and dropped (SPEC §9.3)
  .default({})

export const LlmSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().min(1),
  api_key: z.string().min(1).nullish(),
  base_url: z.string().url().nullish(),
  gigachat_scope: z.enum(GIGACHAT_SCOPES).nullish(),
  context_window_tokens: z.number().int().positive().nullish(),
  capabilities: CapabilitiesOverrideSchema.nullish(),
  params: LlmParamsSchema,
  pricing: PricingSchema.nullish(),
})

export type Llm = z.infer<typeof LlmSchema>

/* ------------------------------------------------------------------ tools */

export const ToolEffectSchema = z.enum(['read', 'write'])
export type ToolEffect = z.infer<typeof ToolEffectSchema>

export const ToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  endpoint: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  effect: ToolEffectSchema, // required (SPEC §6.4)
  /** Hidden from the model until a skill or search activates it (SPEC §6.8). */
  defer_loading: z.boolean().nullish(),
  /** A successful result is rendered to the user: counts toward limits.max_presentations (SPEC §6.9). */
  presents: z.boolean().nullish(),
})

export type ToolDef = z.infer<typeof ToolDefSchema>

/* ----------------------------------------------------------------- skills */

/** Tools the engine implements itself (SPEC §6.8). Reserved names when skills are used. */
export const BUILTIN_TOOLS = { loadSkill: 'load_skill', searchTools: 'search_tools' } as const

export const SKILL_LIMITS = {
  max_skills: 64,
  description_max_chars: 1024,
  body_max_bytes: 32_768,
} as const

export const SkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'name: ^[a-z0-9][a-z0-9_-]{0,63}$'),
  description: z.string().min(1).max(SKILL_LIMITS.description_max_chars),
  body: z
    .string()
    .min(1)
    .refine((body) => Buffer.byteLength(body, 'utf8') <= SKILL_LIMITS.body_max_bytes, {
      error: `body: at most ${SKILL_LIMITS.body_max_bytes} bytes`,
    }),
  tools: z.array(z.string().min(1)).default([]),
})

export type Skill = z.infer<typeof SkillSchema>

/** Tool endpoint response (SPEC §6.2). Any other body = result. */
export const ToolEnvelopeSchema = z.object({
  status: z.enum(['ok', 'error', 'accepted', 'deferred']),
  result: z.unknown().optional(),
  error: z.string().optional(),
  operation_id: z.string().optional(),
})

/* ----------------------------------------------------------- run request */

export const StreamFlagsSchema = z
  .object({
    expose_args: z.boolean().default(false),
    expose_result: z.boolean().default(false),
    expose_reasoning: z.boolean().default(false),
  })
  .default({ expose_args: false, expose_result: false, expose_reasoning: false })

export const CallbackSchema = z.object({
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
})

export const MetaSchema = z.record(z.string(), z.unknown()).default({})

/* --------------------------------------------------------- output checks */

/** Format gate for blocks in the final answer (SPEC §5.4). The schema is compiled in validate.ts. */
export const OUTPUT_CHECK_LIMITS = {
  /** Checks per request. */
  max_checks: 4,
  /** Serialized JSON Schema of one check, bytes. */
  schema_max_bytes: 65_536,
  max_repairs_default: 1,
  /** Ceiling: a request can only tighten it; anything above is clamped. */
  max_repairs_cap: 3,
  /** grounded[] entries per check. */
  max_grounded: 8,
} as const

export const GroundedSchema = z.object({
  /** JSON Pointer into the block; `*` matches every index or key at that level. */
  path: z.string().regex(/^\//, 'path: a JSON Pointer starting with /'),
  tools: z.array(z.string().min(1)).min(1),
})

export const OutputCheckSchema = z.object({
  fence: z.string().regex(/^[a-z0-9-]{1,40}$/, 'fence: ^[a-z0-9-]{1,40}$'),
  schema: z.record(z.string(), z.unknown()),
  max_repairs: z.number().int().nonnegative().optional(),
  /** A block of this fence is rendered to the user (SPEC §6.9). */
  presents: z.boolean().nullish(),
  /** Blocks in the text of a tool step: kept as v1, or dropped (SPEC §5.4). */
  interim: z.enum(['keep', 'drop']).nullish(),
  /** Values that must come from tool results (SPEC §5.4). */
  grounded: z.array(GroundedSchema).max(OUTPUT_CHECK_LIMITS.max_grounded).nullish(),
})

export type OutputCheckInput = z.infer<typeof OutputCheckSchema>

export const RunRequestSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  idempotency_key: z.string().min(1).nullish(),
  history_revision: z.union([z.number(), z.string()]).nullish(),
  llm: LlmSchema,
  system: z.string().nullish(),
  messages: z.array(StoredMessageSchema).min(1),
  tools: z.array(ToolDefSchema).default([]),
  skills: z.array(SkillSchema).max(SKILL_LIMITS.max_skills).default([]),
  limits: LimitsSchema,
  stream: StreamFlagsSchema,
  callback: CallbackSchema.nullish(),
  wait: z.boolean().default(false),
  meta: MetaSchema,
  output_checks: z.array(OutputCheckSchema).max(OUTPUT_CHECK_LIMITS.max_checks).nullish(),
})

export type RunRequest = z.infer<typeof RunRequestSchema>

/* -------------------------------------------------------------- tool-result */

export const ToolResultBodySchema = z
  .object({
    call_id: z.string().min(1),
    result: z.unknown().optional(),
    error: z.string().optional(),
    is_error: z.boolean().optional(),
  })
  .refine((v) => v.result !== undefined || v.error !== undefined || v.is_error === true, {
    error: 'result or error is required',
  })

/* ------------------------------------------------------------------ result */

export type RunStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'stopped_limit'
  | 'awaiting_tool'
  | 'cancelled'
  | 'failed'

export type FinishReason =
  | 'end_turn'
  | 'max_steps'
  | 'max_tokens'
  | 'max_tool_calls'
  | 'max_total_tokens'
  | 'max_cost'
  | 'deferred'
  | 'user'
  | 'shutdown'
  | string // failed / <error.code>

export type ToolCallStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'deferred'
  | 'cancelled'
  | 'not_executed'
  | 'presentation_limit'
  | 'duplicate_write_intent'
  | 'http_error'
  | 'protocol_error'

export interface ToolCallSummary {
  call_id: string
  tool: string
  effect: ToolEffect
  status: ToolCallStatus
  duration_ms: number
  truncated: boolean
  operation_id: string | null
  /** A call of an engine tool (§6.8), not of an HTTP endpoint. */
  builtin?: true
}

export interface UsageCall {
  index: number
  status: 'ok' | 'failed' | 'unknown'
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  finish_reason: string | null
  duration_ms: number
  provider_request_id: string | null
  estimated: boolean
}

export interface UsageTotal {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  calls: number
  unknown_calls: number
  estimated: boolean
}

export interface UsageCost {
  amount: number
  currency: string
  pricing_version: string | null
  estimated: boolean
}

export interface Usage {
  calls: UsageCall[]
  total: UsageTotal
  cost?: UsageCost
}

export interface RunErrorBody {
  code: string
  message: string
  retriable: boolean
  provider_status?: number
  provider_body?: string
}

/**
 * Error for the browser (run token: SSE `done`, `cancel`) — without `provider_body`:
 * the provider response body may quote the prompt. The full one is ENGINE_TOKEN
 * only (SPEC §4.4, §6.6).
 */
export function publicError(error: RunErrorBody): Omit<RunErrorBody, 'provider_body'> {
  const { provider_body: _body, ...rest } = error
  return rest
}

/** Outcome of the check for one fence (SPEC §5.4). */
export type OutputCheckStatus = 'absent' | 'passed' | 'repaired' | 'failed' | 'suppressed'

/** Why the repair failed: attempts exhausted, budget / timeout, provider, stop. */
export type OutputCheckFailReason =
  | 'repairs_exhausted'
  | 'max_total_tokens'
  | 'max_cost'
  | 'run_timeout'
  | 'provider_failure'
  | 'cancelled'
  | 'presentation_limit'

export interface OutputCheckResult {
  fence: string
  status: OutputCheckStatus
  /** Repair steps taken (0 — absent / passed / repair never started). */
  attempts: number
  /** Errors of the original block as `path: message` — for repaired and failed. */
  errors?: string[]
  /** Only when failed. */
  reason?: OutputCheckFailReason
}

/** A presenting tool result or fence block that reached the user (SPEC §6.9). */
export interface Presentation {
  kind: 'tool' | 'fence'
  name: string
  call_id?: string
}

/** How much context is used after the run (SPEC §7). */
export interface RunContext {
  /** Full prompt of the last main-step call + its response + the tool messages after it. */
  used_tokens: number
  /** The window the engine trims the history to (SPEC §5.1). */
  window_tokens: number
  /** true — at least one term is a §5.1 estimate, not provider figures. */
  estimated: boolean
}

/** Body of the callback and of a terminal GET (SPEC §7). */
export interface RunResult {
  contract_version: typeof CONTRACT_VERSION
  run_id: string
  status: Exclude<RunStatus, 'running' | 'cancelling'>
  finish_reason: FinishReason
  history_revision: number | string | null
  meta: Record<string, unknown>
  messages: StoredMessage[]
  usage: Usage
  tool_calls: ToolCallSummary[]
  timing: {
    started_at: string
    finished_at: string
    duration_ms: number
    steps: number
    /** How long the run waited for provider slots, summed over attempts (SPEC §11.6). */
    queue_wait_ms: number
  }
  expires_at: string
  context_trimmed: boolean
  context: RunContext
  /** Only if the request had output_checks; [] — the run never reached a final text (SPEC §5.4). */
  output_checks?: OutputCheckResult[]
  /** A completed run whose answer came from the text-only final step (SPEC §10.1). */
  limit_reached?: FinalAnswerLimit
  /** fallback — the answer is the engine's fixed text (SPEC §10.1); absent — the model's. */
  answer_source?: 'model' | 'fallback'
  /** What reached the user, in order; only with limits.max_presentations (SPEC §6.9). */
  presentations?: Presentation[]
  error: RunErrorBody | null
}
