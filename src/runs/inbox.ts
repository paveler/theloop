/**
 * The run inbox (SPEC §4.11): user messages the harness adds to a running run.
 *
 * The engine is one process with one event loop, so there is no mutex: `accept`, `drain` and
 * `close` are synchronous, and the runner never awaits between its last look at the inbox and
 * the terminal status. Every accepted message ends up in exactly one place — the run's
 * messages (drained) or the result's `pending_messages` (left at close).
 */
import type { InboxMessage, UserMessage } from '../contracts.js'
import { EngineError } from '../errors.js'
import { hashBody } from '../ids.js'

export interface InboxLimits {
  maxMessages: number
  maxBytes: number
}

export type InboxState = 'open' | 'cancelling' | 'finished'

export type AcceptOutcome =
  /** New messages were queued (a repeat of known ones may ride along). */
  | { kind: 'accepted'; ids: string[]; added: number }
  /** Every message is already known with the same body: nothing changes. */
  | { kind: 'duplicate'; ids: string[] }

export class RunInbox {
  private queue: UserMessage[] = []
  /** id → body hash of every message this run accepted: a repeat is answered, not queued twice. */
  private readonly receipts = new Map<string, string>()
  private bytes = 0
  private closed = false
  /** Messages appended to the history so far — result.timing.injected. */
  consumed = 0

  constructor(private readonly limits: InboxLimits) {}

  /** The run accepted at least one message: the result then carries the inbox fields. */
  get used(): boolean {
    return this.receipts.size > 0
  }

  get pending(): number {
    return this.queue.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Repeats are checked before the run's state: a harness that lost the `202` learns the
   * messages are in the result even after the run finished (`run_finished` with `known`).
   * New messages are accepted all together or not at all.
   */
  accept(messages: readonly InboxMessage[], state: InboxState, now: Date = new Date()): AcceptOutcome {
    const fresh: InboxMessage[] = []
    const known: string[] = []
    for (const message of messages) {
      const seen = this.receipts.get(message.id)
      if (seen === undefined) fresh.push(message)
      else if (seen === bodyHash(message)) known.push(message.id)
      else throw new EngineError('inbox_id_mismatch', `message ${message.id} was accepted with a different body`)
    }

    const ids = messages.map((m) => m.id)
    if (fresh.length === 0 && state === 'open') return { kind: 'duplicate', ids }

    if (state === 'cancelling') {
      throw new EngineError('run_cancelling', 'run is being cancelled', known.length > 0 ? { known } : {})
    }
    if (state === 'finished' || this.closed) {
      throw new EngineError('run_finished', 'run has finished: start a new run with these messages', {
        ...(known.length > 0 ? { known } : {}),
      })
    }

    const freshBytes = fresh.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m), 'utf8'), 0)
    if (this.receipts.size + fresh.length > this.limits.maxMessages || this.bytes + freshBytes > this.limits.maxBytes) {
      throw new EngineError('inbox_full', 'run inbox is full: send the rest with the next run', {
        max_messages: this.limits.maxMessages,
        max_bytes: this.limits.maxBytes,
      })
    }

    for (const message of fresh) {
      this.receipts.set(message.id, bodyHash(message))
      this.queue.push(toUserMessage(message, now))
    }
    this.bytes += freshBytes
    return { kind: 'accepted', ids, added: fresh.length }
  }

  /** Everything queued, in arrival order; the caller appends it to the history. */
  drain(): UserMessage[] {
    const out = this.queue
    this.queue = []
    this.consumed += out.length
    return out
  }

  /** No more messages; what is still queued becomes `pending_messages`. Idempotent. */
  close(): UserMessage[] {
    this.closed = true
    const out = this.queue
    this.queue = []
    return out
  }
}

function bodyHash(message: InboxMessage): string {
  return hashBody({ role: message.role, id: message.id, created_at: message.created_at ?? null, content: message.content })
}

/** A missing or invalid created_at gets the time of receipt: the §9.4 date line then never changes. */
function toUserMessage(message: InboxMessage, now: Date): UserMessage {
  const valid = message.created_at != null && !Number.isNaN(new Date(message.created_at).getTime())
  return {
    role: 'user',
    id: message.id,
    created_at: valid ? message.created_at! : now.toISOString(),
    content: message.content,
  }
}
