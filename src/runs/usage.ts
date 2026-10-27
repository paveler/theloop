/**
 * Usage per provider attempt (SPEC §8) and estimated budgets (§10.2).
 *
 * One record for EVERY attempt: ok (usage received), failed (refused before processing,
 * 0 tokens), unknown (network / timeout / 5xx / dropped stream — the provider may have billed).
 * input_tokens is always the uncached input; cache_read / cache_write are separate.
 */
import type { LanguageModelUsage } from 'ai'
import type { Pricing, Usage, UsageCall, UsageCost, UsageTotal } from '../contracts.js'

export interface NormalizedTokens {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
}

const ZERO: NormalizedTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
}

/**
 * The AI SDK (v6) reports usage in one shape for every adapter: inputTokens is the TOTAL
 * prompt, and inputTokenDetails splits it into uncached, cache read and cache write. The
 * engine bills input_tokens as the uncached part (SPEC §8.1).
 */
export function normalizeUsage(usage: LanguageModelUsage | undefined): NormalizedTokens {
  if (!usage) return { ...ZERO }
  const details = usage.inputTokenDetails
  const cacheRead = details?.cacheReadTokens ?? 0
  const cacheWrite = details?.cacheWriteTokens ?? 0
  const input = details?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite)

  return {
    input_tokens: input,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  }
}

export interface AttemptRecord {
  status: 'ok' | 'failed' | 'unknown'
  provider: string
  model: string
  tokens: NormalizedTokens
  finishReason: string | null
  durationMs: number
  providerRequestId: string | null
  estimated: boolean
  /**
   * How much output to reserve in the budget regardless of what was actually seen
   * (SPEC §10.2.3): an unknown attempt counts at worst case = max_tokens, even
   * if zero text was received — the provider may have generated all of it. Usage still
   * gets the actual estimate (§8.2); the reserve lives only in the budget.
   */
  reservedOutput?: number
}

export class UsageTracker {
  private readonly attempts: UsageCall[] = []
  /** Alongside usage we keep the output for the budget — it may be larger. */
  private readonly budgetOutputs: number[] = []

  constructor(private readonly pricing?: Pricing | null) {}

  record(record: AttemptRecord): UsageCall {
    const call: UsageCall = {
      index: this.attempts.length,
      status: record.status,
      provider: record.provider,
      model: record.model,
      ...record.tokens,
      finish_reason: record.finishReason,
      duration_ms: record.durationMs,
      provider_request_id: record.providerRequestId,
      estimated: record.estimated,
    }
    this.attempts.push(call)
    this.budgetOutputs.push(Math.max(record.tokens.output_tokens, record.reservedOutput ?? 0))
    return call
  }

  get calls(): readonly UsageCall[] {
    return this.attempts
  }

  /** total sums ok + unknown; failed has 0 tokens and does not affect the sum. */
  total(): UsageTotal {
    const total: UsageTotal = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      calls: this.attempts.length,
      unknown_calls: 0,
      estimated: false,
    }
    for (const call of this.attempts) {
      if (call.status === 'unknown') total.unknown_calls++
      if (call.status === 'failed') continue
      total.input_tokens += call.input_tokens
      total.output_tokens += call.output_tokens
      total.cache_read_tokens += call.cache_read_tokens
      total.cache_write_tokens += call.cache_write_tokens
      total.reasoning_tokens += call.reasoning_tokens
      if (call.estimated) total.estimated = true
    }
    return total
  }

  cost(): UsageCost | undefined {
    if (!this.pricing) return undefined
    const total = this.total()
    return {
      amount: costOf(total, this.pricing),
      currency: this.pricing.currency,
      pricing_version: this.pricing.version ?? null,
      estimated: total.estimated,
    }
  }

  snapshot(): Usage {
    const cost = this.cost()
    return { calls: [...this.attempts], total: this.total(), ...(cost ? { cost } : {}) }
  }

  /** Full prompt input + output across all attempts — the volume budget (SPEC §10.2). */
  spentTokens(): number {
    const t = this.budgetTotal()
    return t.input_tokens + t.cache_read_tokens + t.cache_write_tokens + t.output_tokens
  }

  spentCost(): number {
    return this.pricing ? costOf(this.budgetTotal(), this.pricing) : 0
  }

  /** Same as total(), but with the worst-case output reserve (SPEC §10.2.3). */
  private budgetTotal(): NormalizedTokens {
    const out: NormalizedTokens = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    }
    this.attempts.forEach((call, index) => {
      if (call.status === 'failed') return
      out.input_tokens += call.input_tokens
      out.cache_read_tokens += call.cache_read_tokens
      out.cache_write_tokens += call.cache_write_tokens
      out.output_tokens += this.budgetOutputs[index] ?? call.output_tokens
    })
    return out
  }
}

export function costOf(tokens: NormalizedTokens, pricing: Pricing): number {
  const raw =
    tokens.input_tokens * pricing.input +
    tokens.output_tokens * pricing.output +
    tokens.cache_read_tokens * pricing.cache_read +
    tokens.cache_write_tokens * pricing.cache_write
  return raw / pricing.per_tokens
}

/* ------------------------------------------------------------- budgets */

export interface BudgetEstimate {
  /** Estimated uncached input of the next attempt. */
  input: number
  /** Cache write, if the cache is not created yet. */
  cacheWrite: number
  /** Cache read, if the cache already exists. */
  cacheRead: number
  /** Worst-case output — limits.max_tokens. */
  output: number
}

export interface BudgetVerdict {
  ok: boolean
  exceeded?: 'max_total_tokens' | 'max_cost'
}

/**
 * Checked before EVERY attempt, including transport retries (SPEC §10.2):
 * spent + worst-case estimate of the next attempt > limit → the run finishes
 * before the call.
 */
export function checkBudgets(
  tracker: UsageTracker,
  estimate: BudgetEstimate,
  limits: { max_total_tokens: number; max_cost?: number },
  pricing?: Pricing | null,
): BudgetVerdict {
  const nextTokens = estimate.input + estimate.cacheRead + estimate.cacheWrite + estimate.output
  if (tracker.spentTokens() + nextTokens > limits.max_total_tokens) {
    return { ok: false, exceeded: 'max_total_tokens' }
  }
  if (limits.max_cost != null && pricing) {
    const nextCost = costOf(
      {
        input_tokens: estimate.input,
        output_tokens: estimate.output,
        cache_read_tokens: estimate.cacheRead,
        cache_write_tokens: estimate.cacheWrite,
        reasoning_tokens: 0,
      },
      pricing,
    )
    if (tracker.spentCost() + nextCost > limits.max_cost) {
      return { ok: false, exceeded: 'max_cost' }
    }
  }
  return { ok: true }
}
