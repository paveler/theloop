/**
 * Builds the model from the request's llm block (SPEC §9.1).
 * Key: llm.api_key → the named provider's env key → 400 provider_key_missing.
 * An env key is used ONLY with a built-in base_url, never with an arbitrary one.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { Config, EndpointConfig } from '../config.js'
import type { Llm, ProviderId } from '../contracts.js'
import { EngineError } from '../errors.js'
import { EgressDeniedError, type EgressClient } from '../egress/client.js'
import { sha256 } from '../ids.js'
import { log, registerSecret } from '../log.js'
import { contextWindowFor, ENDPOINT_OWNER_PREFIX, providerEntry, type ProviderCapabilities } from './allowlist.js'
import { GIGACHAT_OAUTH_URL, gigachatTransport, type GigachatTransport } from './gigachat.js'
import type { ThrottleKey } from './throttle.js'

export interface ResolvedModel {
  providerId: ProviderId
  /** With provider "endpoint": its name; the public reference carries it (SPEC §9.1). */
  endpoint?: string
  /**
   * Whose reasoning this is (SPEC §5.2): the provider id, or `endpoint:<name>`, so a signature
   * is replayed only to where it came from. Absent — providerId.
   */
  reasoningOwner?: string
  /** false — stored reasoning is not sent back to the model (endpoint _REASONING_REPLAY=none). */
  replayReasoning?: boolean
  model: LanguageModel
  capabilities: ProviderCapabilities
  contextWindow: number
  maxTokensCap: number
  /** The provider understands cache_control on system / tools (SPEC §9.3). */
  supportsCacheControl: boolean
  /** Honors tool_choice: none; if not, such steps send no tools (SPEC §9.2). */
  honorsToolChoiceNone: boolean
  /** The model accepts temperature / top_p; if not, they are not sent to the provider (SPEC §9.3). */
  acceptsSampling: boolean
  /** Anthropic tool search: deferred tools activate through tool_reference (SPEC §6.8, §9.2). */
  toolReferences: boolean
  /** Thinking blocks are bound to the prefix: an engine-made edit needs `drop_block` (SPEC §9.3). */
  thinkingPrefixBinding?: boolean
  /** The provider's cache session header; the runner sets the value (SPEC §9.1). */
  sessionHeader?: string
  /** providerOptions for streamText (thinking and the like). */
  providerOptions: Record<string, Record<string, unknown>>
  /** Queue and AIMD ceiling key (SPEC §11.6): provider + hash of key / scope / base_url. */
  throttleKey: ThrottleKey
  /** End of run: free provider-side resources, i.e. GigaChat files (SPEC §5.3). Never throws. */
  release?: (runId: string) => Promise<void>
}

export type ModelFactory = (llm: Llm, config: Config, egress: EgressClient) => ResolvedModel

/**
 * Providers whose thinking maps to reasoning_effort (SPEC §9.3). On
 * deepseek / gigachat reasoning is turned on by the model or its own field: no
 * mapping, the parameter is not sent, a warn goes to the journal. GLM has its own function below.
 */
const THINKING_AS_EFFORT: ReadonlySet<ProviderId> = new Set(['openai', 'openai-compatible'])

/** GLM models whose thinking cannot be disabled, only its depth set (SPEC §9.3). */
const GLM_FORCED_THINKING = /^glm-5\.3/i
/** GLM models that understand reasoning_effort: 5.2 and later. */
const GLM_EFFORT = /^glm-5\.([2-9]|\d{2,})/i

/**
 * New Claude models (SPEC §9.3, Anthropic docs as of 2026-10-12): Opus 4.7+ (4.7, 4.8, 5, 5.5),
 * Sonnet 5+ (5, 5.5), Haiku 5+ (5.5), all Fable and Mythos. They answer 400 to non-default
 * sampling (temperature / top_p / top_k) and to `thinking: { type: "enabled", budget_tokens }`:
 * they only have adaptive thinking, with depth in `output_config.effort`. Later versions of the
 * same lines are matched in advance: a needless drop costs a warn, a miss costs a failed run.
 * Opus / Sonnet 4.6, Haiku 4.5 and older accept both sampling and a budget. @ai-sdk/anthropic
 * drops sampling itself only for the models in its own table, which lags behind the lines, and
 * sends thinking as given, so we do not rely on it.
 */
const NEW_CLAUDE =
  /^claude-(fable|mythos)-|^claude-opus-(4-[7-9]|[5-9]|\d{2,})|^claude-(sonnet|haiku)-([5-9]|\d{2,})/i

export function isNewClaude(model: string): boolean {
  return NEW_CLAUDE.test(model)
}

/**
 * Claude models with tool search (SPEC §9.2): the model table of the tool search docs —
 * Opus / Sonnet / Haiku 4.5 and later, every Fable and Mythos — with later versions of the
 * same lines matched in advance, like NEW_CLAUDE. MiniMax and Kimi use the Anthropic adapter
 * but their APIs have no defer_loading.
 */
const TOOL_REFERENCE_CLAUDE = /^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-(4-[5-9]|[5-9]|\d{2,})/i

export function supportsToolReferences(provider: string, model: string): boolean {
  return provider === 'anthropic' && TOOL_REFERENCE_CLAUDE.test(model)
}

/**
 * Claude models that bind a thinking block to the exact prefix that produced it — system,
 * tools, every earlier message (SPEC §9.3, Anthropic docs as of 2026-10-27): Fable 5.1,
 * Opus 5.5, Sonnet 5.5, Haiku 5.5, later versions of the same lines matched in advance.
 * Mythos does not run the check. Thinking is adaptive by default on all of them, so the
 * engine can send `block_binding` without changing the thinking mode.
 */
const THINKING_PREFIX_CLAUDE =
  /^claude-fable-(5-[1-9]|[6-9]|\d{2,})|^claude-(opus|sonnet|haiku)-(5-[5-9]|[6-9]|\d{2,})/i

export function bindsThinkingToPrefix(provider: string, model: string): boolean {
  return provider === 'anthropic' && THINKING_PREFIX_CLAUDE.test(model)
}

/**
 * Thinking budget → effort for new Claude models, roughly (SPEC §9.3). `xhigh` / `max` are never
 * derived from a budget: `max` spends without a ceiling, `xhigh` is not available on every model
 * (Mythos Preview lacks it).
 */
function claudeEffort(budgetTokens: number): 'low' | 'medium' | 'high' {
  return budgetTokens >= 16_000 ? 'high' : budgetTokens >= 4_000 ? 'medium' : 'low'
}

/**
 * Kimi K3 (SPEC §9.3): thinking cannot be disabled, only its depth set through
 * `output_config.effort` — `low` / `high` / `max`, no `medium`. The provider default is `max`,
 * slow and expensive, so without `params.thinking` the depth is `low`. No `thinking` field:
 * the Messages API of Kimi has none.
 */
function kimiEffort(thinking: { budget_tokens: number } | undefined): 'low' | 'high' | 'max' {
  if (!thinking) return 'low'
  return thinking.budget_tokens >= 16_000 ? 'max' : thinking.budget_tokens >= 4_000 ? 'high' : 'low'
}

/**
 * GLM (SPEC §9.3): on 4.7+ thinking is on by default. Without `params.thinking` it is
 * disabled, and where it cannot be (5.3, 5.3-flash*), the depth is `low`: the default `max`
 * is slow and expensive. With `params.thinking` it is enabled; 5.2+ take the depth from the budget.
 * The fields go into the body as is: the openai-compatible SDK passes providerOptions.glm through.
 */
function glmThinking(model: string, thinking: { budget_tokens: number } | undefined): Record<string, unknown> {
  if (!thinking) {
    return GLM_FORCED_THINKING.test(model) ? { reasoningEffort: 'low' } : { thinking: { type: 'disabled' } }
  }
  const effort = thinking.budget_tokens >= 16_000 ? 'max' : thinking.budget_tokens >= 4_000 ? 'high' : 'low'
  return { thinking: { type: 'enabled' }, ...(GLM_EFFORT.test(model) ? { reasoningEffort: effort } : {}) }
}

/** The reasoning owner of a resolved model (SPEC §5.2). */
export function ownerOf(resolved: Pick<ResolvedModel, 'providerId' | 'reasoningOwner'>): string {
  return resolved.reasoningOwner ?? resolved.providerId
}

export function buildModel(llm: Llm, config: Config, egress: EgressClient): ResolvedModel {
  if (llm.provider === 'endpoint') return buildEndpointModel(llm, config, egress)
  if (llm.endpoint) throw new EngineError('bad_request', 'llm.endpoint is only for provider "endpoint"')
  const entry = providerEntry(llm.provider)

  // base_url: built in for a named provider (or the operator's <PROVIDER>_BASE_URL), from the
  // request for openai-compatible
  let baseUrl = entry.baseUrl
  const override = config.providerBaseUrls[llm.provider]
  if (llm.provider === 'openai-compatible') {
    if (!llm.base_url) {
      throw new EngineError('bad_request', 'openai-compatible requires llm.base_url')
    }
    egress.assertAllowed(llm.base_url, 'llm.base_url')
    baseUrl = llm.base_url
  } else if (llm.base_url) {
    throw new EngineError('bad_request', `llm.base_url is not allowed for provider ${llm.provider}`)
  } else if (override) {
    baseUrl = override
  } else if (!config.egressPublicProviders && entry.baseUrl) {
    // a closed network: fail on receipt instead of hanging on DNS until the run times out (SPEC §11.4)
    throw new EgressDeniedError(
      `provider ${llm.provider}: public provider hosts are off (EGRESS_PUBLIC_PROVIDERS=0); set ${llm.provider.toUpperCase()}_BASE_URL or use an endpoint`,
      { target: 'llm', host: new URL(entry.baseUrl).hostname },
    )
  }

  // key
  const envKey = entry.envKey ? config.providerKeys[entry.envKey] : undefined
  const apiKey = llm.api_key ?? envKey
  registerSecret(apiKey)
  if (!apiKey) {
    throw new EngineError(
      'provider_key_missing',
      `no key for provider ${llm.provider}: neither llm.api_key nor env`,
    )
  }

  const capabilities: ProviderCapabilities = {
    parallel_tools: llm.capabilities?.parallel_tools ?? entry.capabilities.parallel_tools,
    usage_in_stream: llm.capabilities?.usage_in_stream ?? entry.capabilities.usage_in_stream,
  }

  const contextWindow =
    llm.context_window_tokens ?? contextWindowFor(llm.model, config.maxContextFallback)

  const newClaude = llm.provider === 'anthropic' && isNewClaude(llm.model)
  const providerOptions: Record<string, Record<string, unknown>> = {}
  const thinking = llm.params.thinking
  if (llm.provider === 'glm') {
    providerOptions.glm = glmThinking(llm.model, thinking)
  } else if (llm.provider === 'kimi') {
    providerOptions.anthropic = { effort: kimiEffort(thinking) }
  } else if (thinking) {
    if (llm.provider === 'minimax') {
      // MiniMax has no budget: M3 enables thinking only as `adaptive`, M2.x always
      // think and accept it with no effect (SPEC §9.3)
      providerOptions.anthropic = { thinking: { type: 'adaptive' } }
    } else if (newClaude) {
      // new Claude models reject a budget (400): adaptive, with effort derived from the budget.
      // Without params.thinking nothing is sent: on Opus 5.5 / Fable / Mythos it is always on,
      // on Opus 5 / Sonnet 5 / 5.5 / Haiku 5.5 it is on by default (SPEC §9.3)
      providerOptions.anthropic = { thinking: { type: 'adaptive' }, effort: claudeEffort(thinking.budget_tokens) }
    } else if (entry.kind === 'anthropic') {
      providerOptions.anthropic = { thinking: { type: 'enabled', budgetTokens: thinking.budget_tokens } }
    } else if (THINKING_AS_EFFORT.has(llm.provider)) {
      // OpenAI dialect: reasoning effort instead of a budget, mapped roughly. The key is
      // the provider name: the openai-compatible SDK reads providerOptions[<name>]
      providerOptions[llm.provider] = { reasoningEffort: thinking.budget_tokens >= 8000 ? 'high' : 'medium' }
    } else {
      log.warn('llm_param_unsupported', { param: 'thinking', provider: llm.provider, model: llm.model })
    }
  }

  // new Claude models answer 400 to sampling; Kimi K3 has it fixed (temperature 1, top_p 0.95)
  // and rejects other values on its OpenAI API. Not sent, the run proceeds (SPEC §9.3)
  const acceptsSampling = !newClaude && llm.provider !== 'kimi'
  if (!acceptsSampling) {
    for (const param of ['temperature', 'top_p'] as const) {
      if (llm.params[param] != null) {
        log.warn('llm_param_unsupported', { param, provider: llm.provider, model: llm.model })
      }
    }
  }

  // the provider counts the limit per key (GigaChat: per key + scope pair); the key itself
  // never goes past the factory, only its hash
  const scope = llm.provider === 'gigachat' ? (llm.gigachat_scope ?? config.gigachatScope) : ''
  const throttleKey: ThrottleKey = {
    provider: llm.provider,
    hash: sha256(`${llm.provider}|${baseUrl ?? ''}|${scope}|${apiKey}`),
  }

  const providerFetch = egress.providerFetchFor(llm.provider)
  let model: LanguageModel
  let gigachat: GigachatTransport | null = null
  if (entry.kind === 'anthropic') {
    model = createAnthropic({
      apiKey,
      baseURL: baseUrl ?? undefined,
      fetch: providerFetch,
    })(llm.model)
  } else {
    if (llm.provider === 'gigachat') {
      gigachat = gigachatTransport(apiKey, scope, providerFetch, config.gigachatOAuthUrl ?? GIGACHAT_OAUTH_URL)
    }
    model = createOpenAICompatible({
      name: llm.provider,
      baseURL: baseUrl!,
      // GigaChat: Authorization is set by the OAuth wrapper, the static key is not sent
      ...(gigachat ? {} : { apiKey }),
      includeUsage: entry.includeUsage,
      fetch: gigachat?.fetch ?? providerFetch,
    })(llm.model)
  }

  return {
    providerId: llm.provider,
    model,
    capabilities,
    contextWindow,
    maxTokensCap: entry.maxTokensCap,
    supportsCacheControl: entry.kind === 'anthropic',
    honorsToolChoiceNone: entry.honorsToolChoiceNone,
    acceptsSampling,
    toolReferences: supportsToolReferences(llm.provider, llm.model),
    ...(bindsThinkingToPrefix(llm.provider, llm.model) ? { thinkingPrefixBinding: true } : {}),
    ...(entry.sessionHeader ? { sessionHeader: entry.sessionHeader } : {}),
    providerOptions,
    throttleKey,
    ...(gigachat ? { release: gigachat.release } : {}),
  }
}

/**
 * An operator-defined model server (SPEC §9.1): URL, dialect, key, window, caps and
 * concurrency from LLM_ENDPOINT_<NAME>_*. The request names it and may bring its own key.
 */
function buildEndpointModel(llm: Llm, config: Config, egress: EgressClient): ResolvedModel {
  if (!llm.endpoint) throw new EngineError('bad_request', 'provider "endpoint" requires llm.endpoint')
  if (llm.base_url) throw new EngineError('bad_request', 'llm.base_url is not allowed with provider "endpoint"')
  const ep = Object.hasOwn(config.endpoints, llm.endpoint) ? config.endpoints[llm.endpoint] : undefined
  if (!ep) {
    const known = Object.keys(config.endpoints)
    throw new EngineError(
      'bad_request',
      `llm.endpoint: unknown endpoint "${llm.endpoint}"${known.length > 0 ? `; known: ${known.join(', ')}` : '; none is defined (LLM_ENDPOINT_<NAME>_URL)'}`,
    )
  }
  const apiKey = llm.api_key ?? ep.apiKey
  registerSecret(apiKey)
  const owner = `${ENDPOINT_OWNER_PREFIX}${ep.name}`
  const fetchImpl = endpointFetch(egress.providerFetchFor('endpoint'), ep, !apiKey)

  const capabilities: ProviderCapabilities = {
    parallel_tools: llm.capabilities?.parallel_tools ?? ep.parallelTools,
    usage_in_stream: llm.capabilities?.usage_in_stream ?? ep.usageInStream,
  }
  const contextWindow = llm.context_window_tokens ?? ep.contextWindow ?? config.maxContextFallback

  const providerOptions: Record<string, Record<string, unknown>> = {}
  const thinking = llm.params.thinking
  if (thinking) {
    const budget = thinking.budget_tokens
    if (ep.kind === 'openai' && ep.thinking === 'effort') {
      providerOptions[ep.name] = { reasoningEffort: budget >= 8000 ? 'high' : 'medium' }
    } else if (ep.kind === 'anthropic' && ep.thinking === 'budget') {
      providerOptions.anthropic = { thinking: { type: 'enabled', budgetTokens: budget } }
    } else if (ep.kind === 'anthropic' && ep.thinking === 'adaptive') {
      providerOptions.anthropic = { thinking: { type: 'adaptive' }, effort: claudeEffort(budget) }
    } else {
      log.warn('llm_param_unsupported', { param: 'thinking', provider: 'endpoint', endpoint: ep.name, model: llm.model })
    }
  }

  // one queue per server by default: a local server's capacity does not depend on the key (SPEC §11.6)
  const throttleKey: ThrottleKey = {
    provider: owner,
    hash: sha256(ep.concurrencyScope === 'key' ? `${owner}|${ep.url}|${apiKey ?? ''}` : `${owner}|${ep.url}`),
    max: ep.maxConcurrency,
  }

  let model: LanguageModel
  if (ep.kind === 'anthropic') {
    // an explicit key always: the SDK would otherwise read ANTHROPIC_API_KEY from env (SPEC §9.1);
    // the fetch wrapper strips it for a keyless endpoint
    model = createAnthropic({ apiKey: apiKey ?? 'keyless', baseURL: ep.url, fetch: fetchImpl })(llm.model)
  } else {
    model = createOpenAICompatible({
      name: ep.name,
      baseURL: ep.url,
      ...(apiKey ? { apiKey } : {}),
      includeUsage: true,
      fetch: fetchImpl,
    })(llm.model)
  }

  return {
    providerId: 'endpoint',
    endpoint: ep.name,
    reasoningOwner: owner,
    replayReasoning: ep.kind === 'anthropic' || ep.reasoningReplay !== 'none',
    model,
    capabilities,
    contextWindow,
    maxTokensCap: ep.maxTokens,
    supportsCacheControl: ep.kind === 'anthropic',
    honorsToolChoiceNone: ep.toolChoiceNone,
    acceptsSampling: true,
    toolReferences: false,
    ...(ep.prefixBinding ? { thinkingPrefixBinding: true } : {}),
    providerOptions,
    throttleKey,
  }
}

const AUTH_HEADERS = ['authorization', 'x-api-key', 'api-key']

/**
 * The endpoint's fetch: no credential header at all when keyless (SPEC §9.1), and stored
 * reasoning renamed to the field the server reads (`reasoning`; the SDK writes `reasoning_content`).
 */
function endpointFetch(base: typeof fetch, ep: EndpointConfig, keyless: boolean): typeof fetch {
  return (input, init) => {
    let next = init
    if (keyless && init?.headers) {
      const headers = new Headers(init.headers)
      for (const h of AUTH_HEADERS) headers.delete(h)
      next = { ...init, headers }
    }
    if (ep.kind === 'openai' && ep.reasoningReplay === 'reasoning' && typeof next?.body === 'string') {
      next = { ...next, body: renameReasoning(next.body) }
    }
    return base(input, next)
  }
}

export function renameReasoning(body: string): string {
  let parsed: { messages?: Array<Record<string, unknown>> }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    return body
  }
  if (!Array.isArray(parsed.messages)) return body
  let changed = false
  for (const m of parsed.messages) {
    if (m && typeof m === 'object' && 'reasoning_content' in m) {
      m.reasoning = m.reasoning_content
      delete m.reasoning_content
      changed = true
    }
  }
  return changed ? JSON.stringify(parsed) : body
}
