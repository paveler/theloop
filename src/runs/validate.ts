/**
 * POST /runs validation (SPEC §4.2, §5, §10, §11.4).
 * Everything that can be refused before the run is created is refused here: the contract,
 * the history invariant, write-tool context, egress, provider and key, limits.
 */
import type { Config } from '../config.js'
import {
  BUILTIN_TOOLS,
  LIMIT_CAPS,
  LIMIT_DEFAULTS,
  PROVIDER_IDS,
  RunRequestSchema,
  type Limits,
  type RunRequest,
} from '../contracts.js'
import type { EgressClient } from '../egress/client.js'
import { EngineError } from '../errors.js'
import { log } from '../log.js'
import type { ModelFactory, ResolvedModel } from '../providers/factory.js'
import { validateImages } from './images.js'
import { assertLastMessage, assertToolInvariant } from './messages.js'
import { compileOutputChecks, type CompiledOutputCheck } from './output-checks.js'
import { usesSkills } from './skills.js'

export interface ValidatedRun {
  request: RunRequest
  resolved: ResolvedModel
  limits: Limits
  sessionId: string | null
  /** Format gate for the final answer (SPEC §5.4); [] — no checks. */
  outputChecks: CompiledOutputCheck[]
}

export function validateRunRequest(
  raw: unknown,
  deps: { config: Config; egress: EgressClient; modelFactory: ModelFactory },
): ValidatedRun {
  // a provider outside the allowlist gets its own code, not a generic bad_request (SPEC §12.1)
  const rawProvider = (raw as { llm?: { provider?: unknown } })?.llm?.provider
  if (typeof rawProvider === 'string' && !(PROVIDER_IDS as readonly string[]).includes(rawProvider)) {
    throw new EngineError('provider_not_allowed', `provider ${rawProvider} is not in the allowlist`)
  }

  const parsed = RunRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new EngineError('bad_request', `invalid body: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  const request = parsed.data

  // history invariant: every tool_call has a paired tool message, and the history ends
  // with user or tool (SPEC §5)
  assertToolInvariant(request.messages)
  assertLastMessage(request.messages)

  // context for write tools (SPEC §4.2)
  const hasWrite = request.tools.some((t) => t.effect === 'write')
  if (hasWrite) {
    const missing: string[] = []
    if (!request.idempotency_key) missing.push('idempotency_key')
    if (typeof request.meta.session_id !== 'string' || request.meta.session_id.length === 0) {
      missing.push('meta.session_id')
    }
    if (request.history_revision == null) missing.push('history_revision')
    if (missing.length > 0) {
      throw new EngineError(
        'write_context_missing',
        'write tools require idempotency_key, meta.session_id and history_revision',
        { missing },
      )
    }
  }

  assertSkills(request)

  if (!request.callback && !request.wait) {
    throw new EngineError('bad_request', 'callback.url or wait: true is required')
  }

  // egress: tools, callback, images (SPEC §11.4, §5.3)
  for (const tool of request.tools) deps.egress.assertAllowed(tool.endpoint, `tool:${tool.name}`)
  if (request.callback) deps.egress.assertAllowed(request.callback.url, 'callback')
  validateImages(request.messages, deps.egress, deps.config, request.llm.provider)

  // a schema that does not compile is a 400 on receipt, not a surprise at the end of the run (SPEC §5.4)
  const outputChecks = compileOutputChecks(request.output_checks)

  const resolved = deps.modelFactory(request.llm, deps.config, deps.egress)
  const limits = resolveLimits(request, resolved.maxTokensCap)

  warnUnknownParams(request)

  const sessionId =
    typeof request.meta.session_id === 'string' && request.meta.session_id.length > 0
      ? request.meta.session_id
      : null

  return { request, resolved, limits, sessionId, outputChecks }
}

/**
 * Skills and deferred tools (SPEC §4.2, §6.8). Checked only when the request uses the
 * feature: a request without it keeps working with an HTTP tool named like a built-in.
 */
function assertSkills(request: RunRequest): void {
  if (!usesSkills(request)) return
  const reserved = new Set<string>(Object.values(BUILTIN_TOOLS))
  request.tools.forEach((tool, index) => {
    if (reserved.has(tool.name)) {
      throw new EngineError(
        'bad_request',
        `tools[${index}].name "${tool.name}" is reserved when skills or deferred tools are used`,
      )
    }
  })

  // a deferred tool outside every skill is reachable through search_tools
  const toolNames = new Set(request.tools.map((t) => t.name))
  const seen = new Set<string>()
  request.skills.forEach((skill, index) => {
    if (seen.has(skill.name)) throw new EngineError('bad_request', `skills[${index}].name "${skill.name}" is duplicated`)
    seen.add(skill.name)
    for (const name of skill.tools) {
      if (!toolNames.has(name)) throw new EngineError('bad_request', `skills[${index}].tools: unknown tool "${name}"`)
    }
  })
}

const KNOWN_PARAMS = new Set(['temperature', 'top_p', 'stop', 'seed', 'thinking', 'cache'])

function warnUnknownParams(request: RunRequest): void {
  const unknown = Object.keys(request.llm.params).filter((k) => !KNOWN_PARAMS.has(k))
  if (unknown.length > 0) {
    log.warn('llm_params_unknown', { params: unknown, provider: request.llm.provider })
    for (const key of unknown) delete (request.llm.params as Record<string, unknown>)[key]
  }
}

/** Defaults and server caps; the request can only tighten them (SPEC §10). */
export function resolveLimits(request: RunRequest, providerMaxTokens: number): Limits {
  const input = request.limits
  const limits: Limits = {
    max_steps: Math.min(input.max_steps ?? LIMIT_DEFAULTS.max_steps, LIMIT_CAPS.max_steps),
    max_tokens: Math.min(input.max_tokens ?? LIMIT_DEFAULTS.max_tokens, providerMaxTokens),
    max_tool_calls: Math.min(
      input.max_tool_calls ?? LIMIT_DEFAULTS.max_tool_calls,
      LIMIT_CAPS.max_tool_calls,
    ),
    max_total_tokens: Math.min(
      input.max_total_tokens ?? LIMIT_DEFAULTS.max_total_tokens,
      LIMIT_CAPS.max_total_tokens,
    ),
    timeout_ms: Math.min(input.timeout_ms ?? LIMIT_DEFAULTS.timeout_ms, LIMIT_CAPS.timeout_ms),
    tool_result_max_bytes: Math.min(
      input.tool_result_max_bytes ?? LIMIT_DEFAULTS.tool_result_max_bytes,
      LIMIT_CAPS.tool_result_max_bytes,
    ),
    final_answer: input.final_answer !== false,
  }
  // max_cost works only with pricing (SPEC §8.3)
  if (input.max_cost != null) {
    if (request.llm.pricing) limits.max_cost = input.max_cost
    else log.warn('max_cost_ignored', { reason: 'max_cost without llm.pricing — the limit is ignored' })
  }
  return limits
}
