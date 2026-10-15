/**
 * Smoothing the load on a provider (SPEC §11.6).
 *
 * A semaphore with a FIFO queue per limiter key "provider + key / scope": every
 * model call attempt (and every retry) waits for a slot. The concurrency ceiling is
 * AIMD: a 429 halves it (not below 1) and pauses slot granting, a streak of
 * successes raises it back one at a time up to the env ceiling. This way the engine finds
 * the key's real limit on its own and does not hammer a provider that has already said "enough".
 *
 * One process, state in memory (SPEC §11.2). The provider key never gets
 * here: only its hash, and outside (journal, /health) only 8 hex chars of it.
 */
import type { ProviderId } from '../contracts.js'
import { log } from '../log.js'

export interface ThrottleSettings {
  /** false: slots are granted immediately, no queue and no AIMD (PROVIDER_THROTTLE=0). */
  enabled: boolean
  /** Per-provider concurrency ceiling, also the AIMD maximum. */
  maxConcurrency: Record<ProviderId, number>
  /** Maximum time an attempt waits for a slot; the rest of the run's timeout_ms caps it further. */
  queueTimeoutMs: number
  /** Pause in granting slots after a 429. */
  cooldownMs: number
  /** Pause ceiling: a Retry-After longer than this does not extend the pause. */
  maxCooldownMs: number
  /** This many successes in a row raise the ceiling by 1. */
  increaseAfter: number
}

/** Limiter key: provider + hash of key / scope / base_url (the key itself never gets here). */
export interface ThrottleKey {
  provider: ProviderId
  /** sha256 hex; only the first 8 chars go outside. */
  hash: string
}

/** Attempt outcome for AIMD: success raises the ceiling, a 429 cuts it, the rest has no effect. */
export type SlotOutcome = 'ok' | 'rate_limited' | 'neutral'

export interface ThrottleSlot {
  /** Idempotent: a repeated release does nothing. */
  release(outcome: SlotOutcome, info?: { retryAfterMs?: number; runId?: string }): void
}

interface QueueState {
  /** Ceiling at the time of the answer (after AIMD). */
  limit: number
  /** Slots in use at the time of the answer. */
  active: number
  /** Queue depth at enqueue: how many were waiting along with this call (0: slot granted at once). */
  queueDepth: number
  waitedMs: number
}

export type AcquireResult =
  | ({ kind: 'granted'; slot: ThrottleSlot; queued: boolean } & QueueState)
  | ({ kind: 'timeout' } & QueueState)
  | ({ kind: 'aborted' } & QueueState)

export interface LimiterSnapshot {
  provider: ProviderId
  key: string
  limit: number
  max: number
  active: number
  queued: number
  /** Remaining pause after a 429; 0 means no pause. */
  cooldown_ms: number
}

export interface ThrottleSnapshot {
  enabled: boolean
  limiters: LimiterSnapshot[]
}

interface Waiter {
  enqueuedAt: number
  queueDepth: number
  grant: () => void
}

const NOOP_SLOT: ThrottleSlot = { release: () => {} }

export function throttleLabel(key: ThrottleKey): string {
  return key.hash.slice(0, 8)
}

class Limiter {
  limit: number
  active = 0
  readonly queue: Waiter[] = []
  cooldownUntil = 0
  /** Grows on every decrease: a 429 from a slot granted before the decrease does not cut again. */
  epoch = 0
  private successStreak = 0
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly key: ThrottleKey,
    readonly label: string,
    readonly max: number,
    private readonly settings: ThrottleSettings,
    private readonly onIdle: () => void,
  ) {
    this.limit = max
  }

  acquire(signal: AbortSignal, timeoutMs: number): Promise<AcquireResult> {
    const started = Date.now()
    if (signal.aborted) return Promise.resolve({ kind: 'aborted', ...this.state(0, 0) })

    // free and nobody waiting: grant the slot now; otherwise join the tail of the queue (FIFO)
    if (this.queue.length === 0 && this.canGrant()) {
      return Promise.resolve({ kind: 'granted', slot: this.take(), queued: false, ...this.state(0, 0) })
    }

    return new Promise<AcquireResult>((resolve) => {
      const queueDepth = this.queue.length + 1
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter: Waiter = {
        enqueuedAt: started,
        queueDepth,
        grant: () => {
          cleanup()
          resolve({ kind: 'granted', slot: this.take(), queued: true, ...this.state(queueDepth, Date.now() - started) })
        },
      }
      const leave = (kind: 'timeout' | 'aborted') => {
        const index = this.queue.indexOf(waiter)
        if (index === -1) return
        this.queue.splice(index, 1)
        cleanup()
        resolve({ kind, ...this.state(queueDepth, Date.now() - started) })
        this.maybeIdle()
      }
      const onAbort = () => leave('aborted')
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }

      this.queue.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => leave('timeout'), Math.max(0, timeoutMs))
      unref(timer)
      // a slot may have been freed while the queue is not empty: grant in order
      this.pump()
    })
  }

  snapshot(now: number): LimiterSnapshot {
    return {
      provider: this.key.provider,
      key: this.label,
      limit: this.limit,
      max: this.max,
      active: this.active,
      queued: this.queue.length,
      cooldown_ms: Math.max(0, this.cooldownUntil - now),
    }
  }

  private state(queueDepth: number, waitedMs: number): QueueState {
    return { limit: this.limit, active: this.active, queueDepth, waitedMs }
  }

  private canGrant(): boolean {
    return this.active < this.limit && Date.now() >= this.cooldownUntil
  }

  private take(): ThrottleSlot {
    this.active++
    const epoch = this.epoch
    let released = false
    return {
      release: (outcome, info) => {
        if (released) return
        released = true
        this.active--
        if (outcome === 'rate_limited') this.onRateLimited(epoch, info?.retryAfterMs, info?.runId)
        else if (outcome === 'ok') this.onSuccess()
        this.pump()
        this.maybeIdle()
      },
    }
  }

  private pump(): void {
    while (this.queue.length > 0 && this.canGrant()) {
      this.queue.shift()!.grant()
    }
    if (this.queue.length > 0 && Date.now() < this.cooldownUntil) this.armCooldownTimer()
  }

  private armCooldownTimer(): void {
    if (this.cooldownTimer) return
    this.cooldownTimer = setTimeout(
      () => {
        this.cooldownTimer = null
        this.pump()
        this.maybeIdle()
      },
      Math.max(0, this.cooldownUntil - Date.now()),
    )
    unref(this.cooldownTimer)
  }

  /** Multiplicative decrease: ×0.5, not below 1, plus a pause; once per slot "generation". */
  private onRateLimited(epoch: number, retryAfterMs: number | undefined, runId: string | undefined): void {
    this.successStreak = 0
    // the slot was granted before the last decrease: this burst has already been handled
    if (epoch !== this.epoch) return
    this.epoch++
    const from = this.limit
    this.limit = Math.max(1, Math.floor(this.limit / 2))
    const cooldown = Math.min(
      this.settings.maxCooldownMs,
      Math.max(this.settings.cooldownMs, retryAfterMs ?? 0),
    )
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldown)
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
    }
    log.warn('provider_throttle', {
      run_id: runId,
      provider: this.key.provider,
      throttle_key: this.label,
      direction: 'down',
      limit_from: from,
      limit_to: this.limit,
      max: this.max,
      cooldown_ms: cooldown,
      retry_after_ms: retryAfterMs,
      active: this.active,
      queued: this.queue.length,
    })
  }

  /** Additive increase: +1 per success streak, up to the env ceiling. */
  private onSuccess(): void {
    if (this.limit >= this.max) {
      this.successStreak = 0
      return
    }
    this.successStreak++
    if (this.successStreak < this.settings.increaseAfter) return
    this.successStreak = 0
    const from = this.limit
    this.limit++
    log.info('provider_throttle', {
      provider: this.key.provider,
      throttle_key: this.label,
      direction: 'up',
      limit_from: from,
      limit_to: this.limit,
      max: this.max,
      active: this.active,
      queued: this.queue.length,
    })
  }

  /** A fully recovered, idle limiter is not kept: its state equals the default. */
  private maybeIdle(): void {
    if (this.active > 0 || this.queue.length > 0) return
    if (this.limit < this.max || Date.now() < this.cooldownUntil) return
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
    }
    this.onIdle()
  }
}

export class ProviderThrottle {
  private readonly limiters = new Map<string, Limiter>()

  constructor(readonly settings: ThrottleSettings) {}

  /**
   * Waits for a slot. Not granted within timeoutMs → `timeout`, signal fired → `aborted`;
   * neither throws, the caller decides. A granted slot must be released.
   */
  acquire(key: ThrottleKey, signal: AbortSignal, timeoutMs: number): Promise<AcquireResult> {
    if (!this.settings.enabled) {
      if (signal.aborted) return Promise.resolve({ kind: 'aborted', limit: 0, active: 0, queueDepth: 0, waitedMs: 0 })
      return Promise.resolve({ kind: 'granted', slot: NOOP_SLOT, queued: false, limit: 0, active: 0, queueDepth: 0, waitedMs: 0 })
    }
    const id = `${key.provider}\u0000${key.hash}`
    let limiter = this.limiters.get(id)
    if (!limiter) {
      const created: Limiter = new Limiter(
        key,
        throttleLabel(key),
        Math.max(1, Math.floor(this.settings.maxConcurrency[key.provider])),
        this.settings,
        () => {
          if (this.limiters.get(id) === created) this.limiters.delete(id)
        },
      )
      limiter = created
      this.limiters.set(id, limiter)
    }
    return limiter.acquire(signal, timeoutMs)
  }

  snapshot(): ThrottleSnapshot {
    const now = Date.now()
    return {
      enabled: this.settings.enabled,
      limiters: [...this.limiters.values()].map((l) => l.snapshot(now)),
    }
  }
}

/* ----------------------------------------------------------- 429 retries */

/**
 * Retry-After from the provider response, in ms: `retry-after-ms` (OpenAI), `retry-after`
 * in seconds or as an HTTP date. Missing / malformed / in the past → undefined.
 */
export function parseRetryAfter(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined
  const get = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) return value?.trim()
    }
    return undefined
  }
  const ms = get('retry-after-ms')
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.ceil(Number(ms))
  const raw = get('retry-after')
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.ceil(Number(raw) * 1000)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return at > now ? at - now : undefined
}

/**
 * Delay before the n-th retry on a 429 without Retry-After: full jitter,
 * random(0, min(cap, base · 2^(n-1))).
 */
export function rateLimitBackoff(
  retry: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, retry - 1))
  return Math.floor(random() * ceiling)
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
}
