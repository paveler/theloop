/**
 * The provider queue and the AIMD ceiling (SPEC §11.6), 429 retries (SPEC §11.3).
 *
 * The module is tested directly on fake timers; the loop on MockLanguageModelV3 with
 * small env values and real timers (Hono and AI SDK streams do not get along with
 * fake timers).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APICallError } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { createEngine, type Engine } from '../src/app.js'
import type { Llm, RunResult } from '../src/contracts.js'
import type { EgressClient } from '../src/egress/client.js'
import { buildModel } from '../src/providers/factory.js'
import { resetGigachatTokenCache } from '../src/providers/gigachat.js'
import { classifyProviderError } from '../src/runs/provider.js'
import { initLogger, logBuffer } from '../src/log.js'
import type { LogEntry } from '../src/log-buffer.js'
import {
  parseRetryAfter,
  ProviderThrottle,
  rateLimitBackoff,
  type AcquireResult,
  type ThrottleKey,
  type ThrottleSettings,
  type ThrottleSlot,
} from '../src/providers/throttle.js'
import {
  bearer,
  finish,
  hangingStream,
  json,
  mockFactory,
  mockModel,
  runRequest,
  START,
  startServer,
  streamFrom,
  textChunks,
  testConfig,
  waitFor,
} from './helpers.js'

const KEY: ThrottleKey = { provider: 'gigachat', hash: 'abcdef0123456789' }

function settings(overrides: Partial<ThrottleSettings> = {}): ThrottleSettings {
  return {
    enabled: true,
    maxConcurrency: {
      anthropic: 16,
      openai: 16,
      deepseek: 16,
      glm: 16,
      gigachat: 4,
      minimax: 16,
      'openai-compatible': 16,
    },
    queueTimeoutMs: 60_000,
    cooldownMs: 1000,
    maxCooldownMs: 16_000,
    increaseAfter: 3,
    ...overrides,
  }
}

function granted(result: AcquireResult): ThrottleSlot {
  if (result.kind !== 'granted') throw new Error(`expected a slot, got ${result.kind}`)
  return result.slot
}

function journal(event: string): LogEntry[] {
  return logBuffer().query({ events: [event], limit: 1000 }).entries
}

/* ------------------------------------------------------------------ module */

describe('ProviderThrottle: semaphore and FIFO (SPEC §11.6)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('when free — a slot at once, no queue and no wait', async () => {
    const throttle = new ProviderThrottle(settings())
    const result = await throttle.acquire(KEY, new AbortController().signal, 1000)
    expect(result).toMatchObject({ kind: 'granted', queued: false, waitedMs: 0, queueDepth: 0 })
  })

  it('concurrency never exceeds the ceiling, the queue hands out slots in order', async () => {
    const throttle = new ProviderThrottle(settings())
    const signal = new AbortController().signal
    const first = await Promise.all([0, 1, 2, 3].map(() => throttle.acquire(KEY, signal, 60_000)))
    expect(first.every((r) => r.kind === 'granted')).toBe(true)

    const order: number[] = []
    const waiting = [0, 1, 2].map((i) =>
      throttle.acquire(KEY, signal, 60_000).then((r) => {
        order.push(i)
        return r
      }),
    )
    await Promise.resolve()
    expect(throttle.snapshot().limiters[0]).toMatchObject({ limit: 4, active: 4, queued: 3 })
    expect(order).toEqual([])

    granted(first[0]!).release('neutral')
    await Promise.resolve()
    expect(order).toEqual([0])
    expect(throttle.snapshot().limiters[0]).toMatchObject({ active: 4, queued: 2 })

    granted(first[1]!).release('neutral')
    granted(first[2]!).release('neutral')
    const rest = await Promise.all(waiting)
    expect(order).toEqual([0, 1, 2])
    expect(rest.map((r) => r.kind === 'granted' && r.queued)).toEqual([true, true, true])
    expect(rest.map((r) => r.queueDepth)).toEqual([1, 2, 3])
    expect(throttle.snapshot().limiters[0]).toMatchObject({ active: 4, queued: 0 })
  })

  it('not granted within timeoutMs — timeout, removed from the queue, the next waiter is unaffected', async () => {
    vi.useFakeTimers()
    const throttle = new ProviderThrottle(settings({ maxConcurrency: { ...settings().maxConcurrency, gigachat: 1 } }))
    const signal = new AbortController().signal
    const holder = granted(await throttle.acquire(KEY, signal, 1000))

    const late = throttle.acquire(KEY, signal, 500)
    const patient = throttle.acquire(KEY, signal, 10_000)
    await vi.advanceTimersByTimeAsync(500)
    const lateResult = await late
    expect(lateResult.kind).toBe('timeout')
    expect(lateResult.waitedMs).toBe(500)
    expect(throttle.snapshot().limiters[0]!.queued).toBe(1)

    holder.release('neutral')
    const patientResult = await patient
    expect(patientResult.kind).toBe('granted')
    expect(patientResult.queueDepth).toBe(2)
  })

  it('abort while queued — aborted, no slot taken', async () => {
    const throttle = new ProviderThrottle(settings({ maxConcurrency: { ...settings().maxConcurrency, gigachat: 1 } }))
    const holder = granted(await throttle.acquire(KEY, new AbortController().signal, 1000))
    const abort = new AbortController()
    const waiting = throttle.acquire(KEY, abort.signal, 60_000)
    abort.abort()
    const result = await waiting
    expect(result.kind).toBe('aborted')
    expect(result.queueDepth).toBe(1)
    expect(throttle.snapshot().limiters[0]).toMatchObject({ active: 1, queued: 0 })
    // the signal has already fired — do not queue at all (queueDepth 0: this is not a wait for a slot)
    expect(await throttle.acquire(KEY, abort.signal, 60_000)).toMatchObject({ kind: 'aborted', queueDepth: 0 })
    holder.release('neutral')
    // an idle limiter at the default ceiling is not kept
    expect(throttle.snapshot().limiters).toEqual([])
  })

  it('different keys of one provider — separate queues', async () => {
    const throttle = new ProviderThrottle(settings({ maxConcurrency: { ...settings().maxConcurrency, gigachat: 1 } }))
    const signal = new AbortController().signal
    await throttle.acquire(KEY, signal, 1000)
    const other = await throttle.acquire({ provider: 'gigachat', hash: 'ffff0000' }, signal, 1000)
    expect(other).toMatchObject({ kind: 'granted', queued: false })
    expect(throttle.snapshot().limiters.map((l) => l.key).sort()).toEqual(['abcdef01', 'ffff0000'])
  })

  it('PROVIDER_THROTTLE=0 — slots are not counted, no queue', async () => {
    const throttle = new ProviderThrottle(settings({ enabled: false }))
    const signal = new AbortController().signal
    const all = await Promise.all(Array.from({ length: 50 }, () => throttle.acquire(KEY, signal, 0)))
    expect(all.every((r) => r.kind === 'granted' && !r.queued)).toBe(true)
    expect(throttle.snapshot()).toEqual({ enabled: false, limiters: [] })
  })
})

describe('ProviderThrottle: AIMD on 429 (SPEC §11.6)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('429 → ceiling ×0.5 and a cooldown; a burst of 429s from older slots does not cut twice; a run of successes restores the ceiling', async () => {
    vi.useFakeTimers()
    initLogger(testConfig())
    const throttle = new ProviderThrottle(settings())
    const signal = new AbortController().signal
    const slots = (await Promise.all([0, 1, 2, 3].map(() => throttle.acquire(KEY, signal, 60_000)))).map(granted)

    slots[0]!.release('rate_limited', { runId: 'run_a' })
    expect(throttle.snapshot().limiters[0]).toMatchObject({ limit: 2, max: 4, active: 3, cooldown_ms: 1000 })
    // the other three were granted before the decrease — the same burst, the ceiling stays
    slots[1]!.release('rate_limited')
    slots[2]!.release('rate_limited')
    slots[3]!.release('rate_limited')
    expect(throttle.snapshot().limiters[0]).toMatchObject({ limit: 2, active: 0 })

    const down = journal('provider_throttle')
    expect(down).toHaveLength(1)
    expect(down[0]).toMatchObject({
      level: 'warn',
      run_id: 'run_a',
      provider: 'gigachat',
      throttle_key: 'abcdef01',
      direction: 'down',
      limit_from: 4,
      limit_to: 2,
      cooldown_ms: 1000,
    })
    expect(JSON.stringify(down[0])).not.toContain(KEY.hash)

    // cooldown: no slot is granted until it passes
    const next = throttle.acquire(KEY, signal, 60_000)
    let got = false
    void next.then(() => (got = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(got).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const nextSlot = granted(await next)

    // a 429 from a slot granted after the decrease cuts again: 2 → 1, never below 1
    nextSlot.release('rate_limited')
    expect(throttle.snapshot().limiters[0]!.limit).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    granted(await throttle.acquire(KEY, signal, 60_000)).release('rate_limited')
    expect(throttle.snapshot().limiters[0]!.limit).toBe(1)

    // additive increase: increaseAfter = 3 successes in a row → +1, up to the env ceiling
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 9; i++) granted(await throttle.acquire(KEY, signal, 60_000)).release('ok')
    expect(throttle.snapshot().limiters).toEqual([]) // back at the default — the limiter is not kept
    const up = journal('provider_throttle').filter((e) => e.direction === 'up')
    expect(up.map((e) => [e.limit_from, e.limit_to])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ])
  })

  it('Retry-After stretches the cooldown, but not beyond the cap', async () => {
    vi.useFakeTimers()
    const throttle = new ProviderThrottle(settings({ maxCooldownMs: 5000 }))
    const signal = new AbortController().signal
    granted(await throttle.acquire(KEY, signal, 1000)).release('rate_limited', { retryAfterMs: 3000 })
    expect(throttle.snapshot().limiters[0]!.cooldown_ms).toBe(3000)

    await vi.advanceTimersByTimeAsync(3000)
    granted(await throttle.acquire(KEY, signal, 1000)).release('rate_limited', { retryAfterMs: 60_000 })
    expect(throttle.snapshot().limiters[0]!.cooldown_ms).toBe(5000)
  })

  it('5xx, network errors and abort leave the ceiling alone', async () => {
    const throttle = new ProviderThrottle(settings())
    const signal = new AbortController().signal
    for (let i = 0; i < 5; i++) granted(await throttle.acquire(KEY, signal, 1000)).release('neutral')
    expect(throttle.snapshot().limiters).toEqual([])
  })
})

describe('queue env (SPEC §14)', () => {
  it('defaults, per-provider override, an invalid value — the engine does not start', () => {
    const defaults = testConfig()
    expect(defaults.providerThrottle).toMatchObject({ enabled: true, queueTimeoutMs: 60_000, cooldownMs: 1000, increaseAfter: 10 })
    expect(defaults.providerThrottle.maxConcurrency).toMatchObject({ gigachat: 6, anthropic: 16, 'openai-compatible': 16 })
    expect(defaults).toMatchObject({ rateLimitRetries: 5, rateLimitBackoffMs: 1000, rateLimitMaxDelayMs: 16_000 })

    const tuned = testConfig({ PROVIDER_MAX_CONCURRENCY_DEFAULT: '4', PROVIDER_MAX_CONCURRENCY_OPENAI_COMPATIBLE: '2' })
    expect(tuned.providerThrottle.maxConcurrency).toMatchObject({ deepseek: 4, 'openai-compatible': 2, gigachat: 6 })
    expect(testConfig({ PROVIDER_THROTTLE: '0' }).providerThrottle.enabled).toBe(false)
    expect(() => testConfig({ PROVIDER_MAX_CONCURRENCY_GIGACHAT: '0' })).toThrow(/PROVIDER_MAX_CONCURRENCY_GIGACHAT/)
    expect(() => testConfig({ PROVIDER_RATE_LIMIT_RETRIES: '2.5' })).toThrow(/PROVIDER_RATE_LIMIT_RETRIES/)
  })
})

describe('429 retries: Retry-After and full jitter (SPEC §11.3)', () => {
  it('Retry-After: seconds, retry-after-ms, HTTP date; garbage and past dates are ignored', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    expect(parseRetryAfter({ 'retry-after': '2' }, now)).toBe(2000)
    expect(parseRetryAfter({ 'Retry-After': '0.5' }, now)).toBe(500)
    expect(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '9' }, now)).toBe(250)
    expect(parseRetryAfter({ 'retry-after': 'Thu, 08 Oct 2026 12:00:03 GMT' }, now)).toBe(3000)
    expect(parseRetryAfter({ 'retry-after': 'Thu, 08 Oct 2026 11:00:00 GMT' }, now)).toBeUndefined()
    expect(parseRetryAfter({ 'retry-after': 'soon' }, now)).toBeUndefined()
    expect(parseRetryAfter({}, now)).toBeUndefined()
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
  })

  it('full jitter: random(0, min(cap, base · 2^(n-1)))', () => {
    expect(rateLimitBackoff(1, 1000, 16_000, () => 0)).toBe(0)
    expect(rateLimitBackoff(1, 1000, 16_000, () => 0.999)).toBe(999)
    expect(rateLimitBackoff(3, 1000, 16_000, () => 0.5)).toBe(2000)
    expect(rateLimitBackoff(10, 1000, 16_000, () => 0.999)).toBe(15_984)
    for (let retry = 1; retry <= 6; retry++) {
      const ceiling = Math.min(16_000, 1000 * 2 ** (retry - 1))
      for (let i = 0; i < 200; i++) {
        const delay = rateLimitBackoff(retry, 1000, 16_000)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThan(ceiling)
      }
    }
  })
})

describe('throttle key and Retry-After on the real SDK', () => {
  afterEach(() => resetGigachatTokenCache())

  function llm(overrides: Record<string, unknown>): Llm {
    return { provider: 'gigachat', model: 'GigaChat-2-Pro', params: {}, ...overrides } as unknown as Llm
  }

  it('throttle key: provider + a hash of the key and scope; the key itself is not in it', () => {
    const egress = { assertAllowed: () => {}, providerFetchFor: () => fetch } as unknown as EgressClient
    const config = testConfig()
    const a = buildModel(llm({ api_key: 'secret-auth-key-1' }), config, egress).throttleKey
    const same = buildModel(llm({ api_key: 'secret-auth-key-1' }), config, egress).throttleKey
    const otherKey = buildModel(llm({ api_key: 'secret-auth-key-2' }), config, egress).throttleKey
    const otherScope = buildModel(llm({ api_key: 'secret-auth-key-1', gigachat_scope: 'GIGACHAT_API_B2B' }), config, egress)
      .throttleKey
    expect(a.provider).toBe('gigachat')
    expect(a).toEqual(same)
    expect(otherKey.hash).not.toBe(a.hash)
    expect(otherScope.hash).not.toBe(a.hash)
    expect(JSON.stringify(a)).not.toContain('secret-auth-key')
  })

  it('a GigaChat 429 with Retry-After through the real SDK → provider_rate_limited, retryAfterMs', async () => {
    const fakeFetch = (async (url: unknown) => {
      if (String(url).includes('/oauth')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_at: Date.now() + 1_800_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"status":429,"message":"Too Many Requests"}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '2' },
      })
    }) as unknown as typeof fetch
    const egress = { assertAllowed: () => {}, providerFetchFor: () => fakeFetch } as unknown as EgressClient
    const resolved = buildModel(llm({ api_key: 'k' }), testConfig(), egress)
    const model = resolved.model as unknown as { doStream: (opts: Record<string, unknown>) => Promise<unknown> }

    const err = await model
      .doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
      .then(() => null, (e: unknown) => e)

    expect(classifyProviderError(err)).toMatchObject({
      kind: 'failed',
      code: 'provider_rate_limited',
      providerStatus: 429,
      retriable: true,
      retryAfterMs: 2000,
    })
  })
})

/* -------------------------------------------------------------------- loop */

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function track(engine: Engine): Engine {
  cleanup.push(() => engine.shutdown())
  return engine
}

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

/** A background run (wait: false, callback to a local receiver) — for runs hanging in the provider or in the queue. */
async function startBackground(engine: Engine, overrides: Record<string, unknown> = {}): Promise<string> {
  const callbacks = await startServer((_body, _req, res) => json(res, 200, { ok: true }))
  cleanup.push(() => callbacks.close())
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...runRequest(overrides as never), wait: false, callback: { url: `${callbacks.url}/cb` } }),
  })
  expect(res.status).toBe(202)
  return ((await res.json()) as { run_id: string }).run_id
}

async function health(engine: Engine): Promise<any> {
  return (await engine.app.request('/health')).json()
}

function rateLimited(headers: Record<string, string> = {}): LanguageModelV3StreamPart {
  return {
    type: 'error',
    error: new APICallError({
      message: 'Too Many Requests',
      url: 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: headers,
      responseBody: '{"status":429,"message":"Too Many Requests"}',
    }),
  }
}

/** Runs left hanging at engine shutdown do not hold the test for the 7 s grace period. */
const HANG = { SHUTDOWN_GRACE_MS: '50' }

const FAST = {
  PROVIDER_THROTTLE_COOLDOWN_MS: '20',
  PROVIDER_RATE_LIMIT_BACKOFF_MS: '20',
}

describe('loop: provider queue (SPEC §11.6)', () => {
  it('a single run without load: no queue, no wait, one attempt', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('hello'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())

    expect(result.status).toBe('completed')
    expect(result.usage.calls).toHaveLength(1)
    expect(result.timing.queue_wait_ms).toBe(0)
    expect(journal('provider_queue_wait')).toEqual([])
    expect(journal('provider_throttle')).toEqual([])
  })

  it('12 parallel runs at a ceiling of 3: at most 3 in the provider at once, all completed, the wait in timing and the journal', async () => {
    let inFlight = 0
    let peak = 0
    const model = mockModel(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 30))
      inFlight--
      return streamFrom([START, ...textChunks('ok'), finish('stop')])
    })
    const engine = track(
      createEngine(testConfig({ PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '3' }), { modelFactory: mockFactory(model) }),
    )

    const results = await Promise.all(Array.from({ length: 12 }, () => runWait(engine, runRequest())))

    expect(peak).toBe(3)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
    const waited = results.filter((r) => r.timing.queue_wait_ms > 0)
    expect(waited.length).toBeGreaterThanOrEqual(9)
    const waits = journal('provider_queue_wait')
    expect(waits.length).toBeGreaterThanOrEqual(9)
    expect(waits[0]).toMatchObject({ provider: 'anthropic', outcome: 'granted', limit: 3, attempt: 1, step: 1 })
    expect(Math.max(...waits.map((e) => e.queue_depth as number))).toBeGreaterThanOrEqual(8)
  })

  it('no slot freed within PROVIDER_QUEUE_TIMEOUT_MS → failed / provider_queue_timeout, no attempts', async () => {
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(
      createEngine(testConfig({ ...HANG, PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '1', PROVIDER_QUEUE_TIMEOUT_MS: '150' }), {
        modelFactory: mockFactory(model),
      }),
    )

    await startBackground(engine)
    await waitFor(async () => (await health(engine)).provider_throttle.limiters[0]?.active === 1)

    const started = Date.now()
    const result = await runWait(engine, runRequest())

    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.status).toBe('failed')
    expect(result.finish_reason).toBe('provider_queue_timeout')
    expect(result.error).toMatchObject({ code: 'provider_queue_timeout', retriable: true })
    expect(result.usage.calls).toEqual([])
    expect(result.timing.queue_wait_ms).toBeGreaterThanOrEqual(140)
    const wait = journal('provider_queue_wait').find((e) => e.run_id === result.run_id)
    expect(wait).toMatchObject({ level: 'warn', outcome: 'timeout', queue_timeout_ms: 150, queue_depth: 1 })
  })

  it('the slot wait counts against the run timeout_ms: time runs out in the queue — provider_queue_timeout, not a hang', async () => {
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(
      createEngine(testConfig({ ...HANG, PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '1' }), { modelFactory: mockFactory(model) }),
    )

    await startBackground(engine)
    await waitFor(async () => (await health(engine)).provider_throttle.limiters[0]?.active === 1)

    // the env queue timeout is 60 s, but the run is given 200 ms
    const result = await runWait(engine, runRequest({ limits: { timeout_ms: 200 } as never }))

    expect(result.status).toBe('failed')
    expect(result.finish_reason).toBe('provider_queue_timeout')
    expect(result.usage.calls).toEqual([])
    expect(result.timing.duration_ms).toBeLessThan(1500)
  })

  it('cancelling a queued run — cancelled / user, the queue is clean', async () => {
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(
      createEngine(testConfig({ ...HANG, PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '1' }), { modelFactory: mockFactory(model) }),
    )

    await startBackground(engine)
    await waitFor(async () => (await health(engine)).provider_throttle.limiters[0]?.active === 1)
    const queued = await startBackground(engine)
    await waitFor(async () => (await health(engine)).provider_throttle.limiters[0]?.queued === 1)

    const res = await engine.app.request(`/runs/${queued}/cancel`, { method: 'POST', headers: bearer() })
    expect(res.status).toBe(200)
    const result = (await res.json()) as RunResult
    expect(result).toMatchObject({ status: 'cancelled', finish_reason: 'user' })
    expect(result.usage.calls).toEqual([])
    expect((await health(engine)).provider_throttle.limiters[0]).toMatchObject({ active: 1, queued: 0 })
  })

  it('/health: ceiling, busy slots and queue per provider key', async () => {
    const model = mockModel(async ({ abortSignal }) => hangingStream([START, ...textChunks('thinking')], abortSignal))
    const engine = track(
      createEngine(testConfig({ ...HANG, PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '2' }), { modelFactory: mockFactory(model) }),
    )

    expect((await health(engine)).provider_throttle).toEqual({ enabled: true, limiters: [] })
    for (let i = 0; i < 3; i++) await startBackground(engine)
    await waitFor(async () => (await health(engine)).provider_throttle.limiters[0]?.queued === 1)
    const body = await health(engine)
    expect(body.ok).toBe(true)
    expect(body.provider_throttle.limiters).toEqual([
      { provider: 'anthropic', key: 'test-key', limit: 2, max: 2, active: 2, queued: 1, cooldown_ms: 0 },
    ])
  })
})

describe('loop: 429 retries (SPEC §11.3)', () => {
  it('429 with Retry-After → a pause exactly per the header, a retry, completed; the ceiling dropped', async () => {
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      if (attempts === 1) return streamFrom([START, rateLimited({ 'retry-after-ms': '300' })])
      return streamFrom([START, ...textChunks('second try'), finish('stop')])
    })
    const engine = track(createEngine(testConfig(FAST), { modelFactory: mockFactory(model) }))

    const started = Date.now()
    const result = await runWait(engine, runRequest())

    expect(Date.now() - started).toBeGreaterThanOrEqual(295)
    expect(attempts).toBe(2)
    expect(result.status).toBe('completed')
    expect(result.usage.calls.map((c) => c.status)).toEqual(['failed', 'ok'])
    const failure = journal('provider_failure')[0]!
    expect(failure).toMatchObject({
      code: 'provider_rate_limited',
      retry_in_ms: 300,
      retry_after_ms: 300,
      rate_limit_retry: 0,
    })
    expect(journal('provider_throttle')[0]).toMatchObject({ direction: 'down', limit_from: 16, limit_to: 8 })
    expect((await health(engine)).provider_throttle.limiters[0]).toMatchObject({ limit: 8, max: 16 })
  })

  it('429 without Retry-After → full jitter within base · 2^(n-1); up to PROVIDER_RATE_LIMIT_RETRIES attempts beyond the first', async () => {
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      return streamFrom([START, rateLimited()])
    })
    const engine = track(
      createEngine(testConfig({ ...FAST, PROVIDER_RATE_LIMIT_RETRIES: '4', PROVIDER_THROTTLE_COOLDOWN_MS: '0' }), {
        modelFactory: mockFactory(model),
      }),
    )

    const result = await runWait(engine, runRequest())

    expect(attempts).toBe(5) // 1 + 4 retries; network / 5xx errors still get 1 + 2
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_rate_limited')
    expect(result.usage.calls.every((c) => c.status === 'failed')).toBe(true)
    const failures = journal('provider_failure')
    expect(failures).toHaveLength(5)
    failures.slice(0, 4).forEach((f, i) => {
      expect(f.retry_in_ms).toBeGreaterThanOrEqual(0)
      expect(f.retry_in_ms).toBeLessThan(20 * 2 ** i)
    })
    expect(failures[4]).toMatchObject({ retry_in_ms: null, retry_skipped: 'retries_exhausted' })
  })

  it('Retry-After does not fit in the run timeout_ms → no retry and no sleep, failed / provider_rate_limited', async () => {
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      return streamFrom([START, rateLimited({ 'retry-after': '600' })])
    })
    const engine = track(createEngine(testConfig(FAST), { modelFactory: mockFactory(model) }))

    const started = Date.now()
    const result = await runWait(engine, runRequest())

    expect(Date.now() - started).toBeLessThan(1000)
    expect(attempts).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_rate_limited')
    expect(journal('provider_failure')[0]).toMatchObject({ retry_in_ms: null, retry_after_ms: 600_000, retry_skipped: 'run_deadline' })
  })

  it('a 429 retry queues again: ceiling 1, two runs — both completed, the provider never sees two at once', async () => {
    let inFlight = 0
    let peak = 0
    let calls = 0
    const model = mockModel(async () => {
      calls++
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      if (calls === 1) return streamFrom([START, rateLimited()])
      return streamFrom([START, ...textChunks('ok'), finish('stop')])
    })
    const engine = track(
      createEngine(testConfig({ ...FAST, PROVIDER_MAX_CONCURRENCY_ANTHROPIC: '1' }), { modelFactory: mockFactory(model) }),
    )

    const results = await Promise.all([runWait(engine, runRequest()), runWait(engine, runRequest())])

    expect(peak).toBe(1)
    expect(results.map((r) => r.status)).toEqual(['completed', 'completed'])
    expect(calls).toBe(3)
  })

  it('a 429 after the first content event is not retried blindly: provider_stream_interrupted', async () => {
    let attempts = 0
    const model = mockModel(async () => {
      attempts++
      return streamFrom([START, ...textChunks('started'), rateLimited()])
    })
    const engine = track(createEngine(testConfig(FAST), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())

    expect(attempts).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('provider_stream_interrupted')
  })
})
