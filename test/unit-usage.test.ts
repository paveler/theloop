import type { LanguageModelUsage } from 'ai'
import { describe, expect, it } from 'vitest'
import type { Pricing } from '../src/contracts.js'
import { checkBudgets, costOf, normalizeUsage, UsageTracker } from '../src/runs/usage.js'

const pricing: Pricing = {
  input: 3,
  output: 15,
  cache_read: 0.3,
  cache_write: 3.75,
  per_tokens: 1_000_000,
  currency: 'USD',
  version: '2026-09',
}

const zeroTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
}

/** LanguageModelUsage as the AI SDK v6 reports it for every adapter. */
function sdkUsage(fields: {
  input: number
  noCache?: number
  cacheRead?: number
  cacheWrite?: number
  output: number
  reasoning?: number
}): LanguageModelUsage {
  return {
    inputTokens: fields.input,
    inputTokenDetails: {
      noCacheTokens: fields.noCache,
      cacheReadTokens: fields.cacheRead,
      cacheWriteTokens: fields.cacheWrite,
    },
    outputTokens: fields.output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: fields.reasoning },
    totalTokens: fields.input + fields.output,
  }
}

describe('usage normalization (SPEC §8.1)', () => {
  it('input_tokens is the uncached part; cache read and write are separate', () => {
    const tokens = normalizeUsage(
      sdkUsage({ input: 2620, noCache: 320, cacheRead: 1500, cacheWrite: 800, output: 96 }),
    )
    expect(tokens).toEqual({
      input_tokens: 320,
      output_tokens: 96,
      cache_read_tokens: 1500,
      cache_write_tokens: 800,
      reasoning_tokens: 0,
    })
  })

  it('without the uncached split, the cache is subtracted from the total', () => {
    const tokens = normalizeUsage(sdkUsage({ input: 2000, cacheRead: 1500, output: 100 }))
    expect(tokens.input_tokens).toBe(500)
    expect(tokens.cache_read_tokens).toBe(1500)
  })

  it('reasoning_tokens are informational and not subtracted from output', () => {
    const tokens = normalizeUsage(sdkUsage({ input: 10, output: 200, reasoning: 150 }))
    expect(tokens.output_tokens).toBe(200)
    expect(tokens.reasoning_tokens).toBe(150)
  })

  it('no usage is zero', () => {
    expect(normalizeUsage(undefined)).toEqual(zeroTokens)
  })
})

describe('aggregation of attempts (SPEC §8.1, §8.2)', () => {
  it('total sums ok and unknown, failed does not count, unknown_calls is tracked', () => {
    const tracker = new UsageTracker(pricing)
    tracker.record({
      status: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      tokens: { ...zeroTokens, input_tokens: 1820, output_tokens: 96, cache_read_tokens: 1500 },
      finishReason: 'tool-calls',
      durationMs: 1830,
      providerRequestId: 'req_1',
      estimated: false,
    })
    tracker.record({
      status: 'failed',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      tokens: { ...zeroTokens },
      finishReason: null,
      durationMs: 40,
      providerRequestId: null,
      estimated: false,
    })
    tracker.record({
      status: 'unknown',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      tokens: { ...zeroTokens, input_tokens: 2010, output_tokens: 214, cache_read_tokens: 1950 },
      finishReason: 'stop',
      durationMs: 2410,
      providerRequestId: null,
      estimated: true,
    })

    const total = tracker.total()
    expect(total.calls).toBe(3)
    expect(total.unknown_calls).toBe(1)
    expect(total.input_tokens).toBe(3830)
    expect(total.output_tokens).toBe(310)
    expect(total.cache_read_tokens).toBe(3450)
    expect(total.estimated).toBe(true)
  })

  it('cost is computed from the request pricing: the example from SPEC §8.3', () => {
    const amount = costOf(
      { ...zeroTokens, input_tokens: 3830, output_tokens: 310, cache_read_tokens: 3450 },
      pricing,
    )
    expect(amount).toBeCloseTo(0.017175, 9)
  })

  it('without pricing there is no cost', () => {
    const tracker = new UsageTracker(null)
    expect(tracker.snapshot().cost).toBeUndefined()
  })
})

describe('max_total_tokens / max_cost budgets (SPEC §10.2)', () => {
  const estimate = { input: 1000, cacheWrite: 500, cacheRead: 0, output: 4096 }

  it('allows while spent plus worst case fits', () => {
    const tracker = new UsageTracker(pricing)
    const verdict = checkBudgets(tracker, estimate, { max_total_tokens: 10_000 }, pricing)
    expect(verdict.ok).toBe(true)
  })

  it('the next attempt estimate counts in full, including cache write and worst-case output', () => {
    const tracker = new UsageTracker(pricing)
    const verdict = checkBudgets(tracker, estimate, { max_total_tokens: 5000 }, pricing)
    expect(verdict).toEqual({ ok: false, exceeded: 'max_total_tokens' })
  })

  it('an unknown attempt takes its worst case from the budget and never gives it back', () => {
    const tracker = new UsageTracker(pricing)
    tracker.record({
      status: 'unknown',
      provider: 'anthropic',
      model: 'm',
      tokens: { ...zeroTokens, input_tokens: 3000, output_tokens: 4096 },
      finishReason: null,
      durationMs: 10,
      providerRequestId: null,
      estimated: true,
    })
    expect(tracker.spentTokens()).toBe(7096)
    const verdict = checkBudgets(tracker, estimate, { max_total_tokens: 10_000 }, pricing)
    expect(verdict).toEqual({ ok: false, exceeded: 'max_total_tokens' })
  })

  it('max_cost hits before max_total_tokens when pricing is expensive', () => {
    const tracker = new UsageTracker(pricing)
    const verdict = checkBudgets(
      tracker,
      estimate,
      { max_total_tokens: 1_000_000, max_cost: 0.001 },
      pricing,
    )
    expect(verdict).toEqual({ ok: false, exceeded: 'max_cost' })
  })

  it('without pricing max_cost is not checked', () => {
    const tracker = new UsageTracker(null)
    const verdict = checkBudgets(tracker, estimate, { max_total_tokens: 1_000_000, max_cost: 0.000001 })
    expect(verdict.ok).toBe(true)
  })
})
