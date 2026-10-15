/**
 * Server-side provider allowlist (SPEC §9.1). The harness passes provider + model;
 * kind, the built-in base_url, the env key name, capabilities (§9.2), hard caps (§10) and
 * context window profiles (§5.1) live only here.
 *
 * The model is an arbitrary string; the provider itself validates it (SPEC §4.2).
 */
import type { ProviderId } from '../contracts.js'

export interface ProviderCapabilities {
  /** Whether it can return several tool calls in one turn (SPEC §6.3, §9.2). */
  parallel_tools: boolean
  /** Whether usage arrives in the stream; if not, usage is estimated (SPEC §8.2). */
  usage_in_stream: boolean
}

export interface ProviderEntry {
  kind: 'anthropic' | 'openai-compatible'
  /** Built-in base_url; null for openai-compatible, which takes it from the request. */
  baseUrl: string | null
  /** Key name in Config.providerKeys; null means env keys do not apply. */
  envKey: string | null
  capabilities: ProviderCapabilities
  /** Per-provider ceiling for limits.max_tokens (SPEC §10). */
  maxTokensCap: number
  /** Send stream_options.include_usage (OpenAI dialect). */
  includeUsage: boolean
  /**
   * The provider honors tool_choice: none. If not, such steps (§5.4, §6.7) send no tools
   * at all: glm-5.3-flash calls tools even with none (verified live).
   */
  honorsToolChoiceNone: boolean
  /**
   * Session header under which the provider keeps the prompt cache. Without it GigaChat
   * caches only the prefix common to all requests, not the conversation history (SPEC §9.1).
   */
  sessionHeader?: string
}

export const PROVIDERS: Record<ProviderId, ProviderEntry> = {
  anthropic: {
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'anthropic',
    capabilities: { parallel_tools: true, usage_in_stream: true },
    maxTokensCap: 32_000,
    includeUsage: false,
    honorsToolChoiceNone: true,
  },
  openai: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'openai',
    capabilities: { parallel_tools: true, usage_in_stream: true },
    maxTokensCap: 32_000,
    includeUsage: true,
    honorsToolChoiceNone: true,
  },
  deepseek: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'deepseek',
    capabilities: { parallel_tools: true, usage_in_stream: true },
    maxTokensCap: 8_192,
    includeUsage: true,
    honorsToolChoiceNone: true,
  },
  glm: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'glm',
    // verified live on 4.7, 5.3, 5.3-flash: three tool_calls per turn, usage in the final chunk
    capabilities: { parallel_tools: true, usage_in_stream: true },
    // thinking counts toward max_tokens; on 5.3 it cannot be disabled (SPEC §9.3)
    maxTokensCap: 64_000,
    includeUsage: true,
    honorsToolChoiceNone: false,
  },
  gigachat: {
    kind: 'openai-compatible',
    baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
    envKey: 'gigachat',
    capabilities: { parallel_tools: false, usage_in_stream: true },
    maxTokensCap: 8_192,
    includeUsage: false,
    honorsToolChoiceNone: true,
    sessionHeader: 'X-Session-ID',
  },
  minimax: {
    // Anthropic-compatible API, the one MiniMax recommends: signed thinking blocks
    // (interleaved thinking between tools), cache_control, Anthropic-style usage (SPEC §9.1)
    kind: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    envKey: 'minimax',
    capabilities: { parallel_tools: true, usage_in_stream: true },
    // thinking counts toward max_tokens and M2.x always think, so the ceiling is above Anthropic's
    maxTokensCap: 64_000,
    includeUsage: false,
    honorsToolChoiceNone: true,
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    baseUrl: null, // from the request; env keys are never used with it (SPEC §9.1)
    envKey: null,
    capabilities: { parallel_tools: false, usage_in_stream: false }, // conservative default
    maxTokensCap: 32_000,
    includeUsage: true,
    honorsToolChoiceNone: true,
  },
}

/** Context window profiles by model name (SPEC §5.1). */
const CONTEXT_PROFILES: Array<[RegExp, number]> = [
  [/^claude-/i, 200_000],
  [/^gpt-5/i, 400_000],
  [/^gpt-4\.1/i, 1_047_576],
  [/^gpt-/i, 128_000],
  [/^o[13]/i, 200_000],
  [/^deepseek-/i, 65_536],
  [/^glm-5\.([2-9]|\d{2,})/i, 1_000_000], // 5.2, 5.3, 5.3-flash*
  [/^glm-5/i, 200_000],
  [/^glm-4\.[67]($|-)/i, 200_000], // 4.6, 4.7, 4.7-flash*; not 4.6v
  [/^glm-/i, 128_000],
  [/^gigachat/i, 32_000],
  [/^minimax-m3/i, 1_000_000],
  [/^minimax-m2/i, 204_800],
]

export function contextWindowFor(model: string, fallback: number): number {
  for (const [re, size] of CONTEXT_PROFILES) if (re.test(model)) return size
  return fallback
}

export function providerEntry(id: ProviderId): ProviderEntry {
  return PROVIDERS[id]
}

/**
 * The providerMetadata / providerOptions key in the AI SDK. The Anthropic adapter always
 * writes and reads `anthropic`, openai-compatible uses the name it was created with (= provider).
 * Not to be confused with `reasoning.provider`: for MiniMax it is `minimax`, so that its
 * signature never goes to the real Anthropic and vice versa (SPEC §5.2).
 */
export function sdkKeyFor(provider: string): string {
  return PROVIDERS[provider as ProviderId]?.kind === 'anthropic' ? 'anthropic' : provider
}

/** Built-in base_urls are always allowed for egress (SPEC §11.4). */
export function pinnedProviderHosts(): string[] {
  const hosts = new Set<string>()
  for (const entry of Object.values(PROVIDERS)) {
    if (!entry.baseUrl) continue
    try {
      hosts.add(new URL(entry.baseUrl).hostname)
    } catch {
      /* impossible: base_url is built in */
    }
  }
  hosts.add('ngw.devices.sberbank.ru') // GigaChat OAuth (SPEC §9.1)
  return [...hosts]
}
