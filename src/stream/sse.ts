/**
 * The run's SSE stream (SPEC §6.6): monotonic id, a buffer for replay by Last-Event-ID,
 * snapshot with the through_event_id watermark, gap on eviction, ping every 15 s.
 *
 * By default only text and anonymized tool progress go out —
 * exposing args / result / reasoning is enabled by stream.expose_* flags in the
 * request, and the runner decides that: what arrives here is already filtered.
 */

export type SseEventName =
  | 'start'
  | 'delta'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'snapshot'
  | 'step'
  | 'output_check'
  | 'done'
  | 'gap'

interface StoredEvent {
  id: number
  event: SseEventName
  data: string
  bytes: number
}

interface SnapshotToolCall {
  call_id: string
  tool: string
  status: string
}

/** Latest gate state per fence (SPEC §5.4) — for the snapshot. */
interface SnapshotOutputCheck {
  fence: string
  attempt: number
  status: string
}

interface Subscriber {
  minId: number
  push: (chunk: string) => void
  close: () => void
}

const PING_INTERVAL_MS = 15_000

export class SseHub {
  private events: StoredEvent[] = []
  private nextId = 1
  private bufferedBytes = 0
  private evicted = false
  private doneEvent: StoredEvent | null = null
  private subscribers = new Set<Subscriber>()
  private closed = false

  // accumulated state for the snapshot
  private text = ''
  private reasoning = ''
  private step = 0
  private toolCalls: SnapshotToolCall[] = []
  private outputChecks: SnapshotOutputCheck[] = []

  constructor(private readonly maxBytes: number) {}

  get lastId(): number {
    return this.nextId - 1
  }

  /** id of the last event, not counting done — the snapshot watermark. */
  private get watermark(): number {
    return this.doneEvent ? this.doneEvent.id - 1 : this.lastId
  }

  emit(event: SseEventName, data: Record<string, unknown>): number {
    if (this.closed) return this.lastId
    const id = this.nextId++
    const payload = JSON.stringify(data)
    const stored: StoredEvent = { id, event, data: payload, bytes: payload.length + 32 }

    this.applyToSnapshot(event, data)

    if (event === 'done') {
      this.doneEvent = stored
      // terminal: the buffer collapses into snapshot + done (SPEC §11.5)
      this.events = []
      this.bufferedBytes = 0
      this.evicted = true
    } else {
      this.events.push(stored)
      this.bufferedBytes += stored.bytes
      while (this.bufferedBytes > this.maxBytes && this.events.length > 0) {
        const dropped = this.events.shift()!
        this.bufferedBytes -= dropped.bytes
        this.evicted = true
      }
    }

    const frame = formatEvent(stored)
    for (const sub of this.subscribers) {
      if (id > sub.minId) sub.push(frame)
    }
    if (event === 'done') this.closeSubscribers()
    return id
  }

  private applyToSnapshot(event: SseEventName, data: Record<string, unknown>): void {
    switch (event) {
      case 'delta':
        this.text += String(data.text ?? '')
        break
      case 'reasoning':
        this.reasoning += String(data.text ?? '')
        break
      case 'tool_call':
        this.toolCalls.push({
          call_id: String(data.call_id),
          tool: String(data.tool),
          status: 'pending',
        })
        break
      case 'tool_result': {
        const callId = String(data.call_id)
        const entry = this.toolCalls.find((c) => c.call_id === callId)
        if (entry) entry.status = typeof data.status === 'string' ? data.status : data.ok ? 'ok' : 'error'
        break
      }
      case 'step':
        this.step = Number(data.index ?? this.step)
        break
      case 'output_check': {
        const entry = { fence: String(data.fence), attempt: Number(data.attempt ?? 0), status: String(data.status) }
        const existing = this.outputChecks.find((c) => c.fence === entry.fence)
        if (existing) Object.assign(existing, entry)
        else this.outputChecks.push(entry)
        break
      }
      default:
        break
    }
  }

  snapshotData(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      through_event_id: this.watermark,
      text: this.text,
      tool_calls: this.toolCalls.map((c) => ({ ...c })),
      step: this.step,
    }
    if (this.reasoning.length > 0) out.reasoning = this.reasoning
    if (this.outputChecks.length > 0) out.output_checks = this.outputChecks.map((c) => ({ ...c }))
    return out
  }

  /**
   * Subscribe. lastEventId within the buffer window → exact replay of the tail; otherwise
   * gap (if the client asked for a specific id) + snapshot + everything after it.
   */
  subscribe(lastEventId: number | null): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const hub = this
    let subscriber: Subscriber | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    // remove both the timer and the subscription — otherwise ping keeps ticking on a closed
    // controller after done, and the subscriber piles up in hub.subscribers
    const detach = () => {
      if (ping) {
        clearInterval(ping)
        ping = null
      }
      if (subscriber) {
        hub.subscribers.delete(subscriber)
        subscriber = null
      }
    }

    const source = {
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        let open = true
        // the initial burst (snapshot + replay + done) does not count as lagging:
        // its size does not depend on the subscriber, and a large snapshot would otherwise
        // cut the stream before done — on every reconnect
        let replaying = true
        let burstBytes = 0
        const close = () => {
          if (!open) return
          open = false
          detach()
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        const push = (chunk: string) => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            open = false
            detach()
            return
          }
          // backpressure: a subscriber lagging behind the live stream by more than the size
          // of the replay buffer (beyond the initial burst) is disconnected — it will come back
          // with Last-Event-ID and get a snapshot
          if (!replaying && controller.desiredSize != null && controller.desiredSize < -burstBytes) close()
        }

        const bufferStart = hub.events.length > 0 ? hub.events[0]!.id : hub.nextId
        const canReplay = lastEventId != null && lastEventId + 1 >= bufferStart

        if (canReplay) {
          for (const ev of hub.events) if (ev.id > lastEventId) push(formatEvent(ev))
          if (hub.doneEvent && hub.doneEvent.id > lastEventId) push(formatEvent(hub.doneEvent))
          subscriber = { minId: Math.max(lastEventId, hub.lastId), push, close }
        } else {
          if (lastEventId != null && hub.evicted) {
            push(formatEvent({ id: 0, event: 'gap', data: JSON.stringify({ from: lastEventId }), bytes: 0 }, true))
          }
          const watermark = hub.watermark
          push(
            formatEvent({
              id: watermark,
              event: 'snapshot',
              data: JSON.stringify(hub.snapshotData()),
              bytes: 0,
            }),
          )
          for (const ev of hub.events) if (ev.id > watermark) push(formatEvent(ev))
          if (hub.doneEvent) push(formatEvent(hub.doneEvent))
          subscriber = { minId: hub.lastId, push, close }
        }

        if (hub.closed || hub.doneEvent) {
          close()
          return
        }

        replaying = false
        burstBytes = Math.max(0, hub.maxBytes - (controller.desiredSize ?? hub.maxBytes))

        hub.subscribers.add(subscriber)
        ping = setInterval(() => push(': ping\n\n'), PING_INTERVAL_MS)
        if (typeof ping.unref === 'function') ping.unref()
      },
      cancel() {
        detach()
      },
    }

    // the queue is measured in bytes, the ceiling is the same as the replay buffer's
    return new ReadableStream<Uint8Array>(
      source,
      new ByteLengthQueuingStrategy({ highWaterMark: this.maxBytes }),
    )
  }

  private closeSubscribers(): void {
    for (const sub of this.subscribers) sub.close()
    this.subscribers.clear()
  }

  /** Full close — the run is being removed from memory. */
  close(): void {
    this.closed = true
    this.closeSubscribers()
  }

  get bytes(): number {
    return this.bufferedBytes
  }

  /** Size of the accumulated snapshot — it lives until the run is deleted (SPEC §11.5). */
  get snapshotBytes(): number {
    return (
      Buffer.byteLength(this.text, 'utf8') +
      Buffer.byteLength(this.reasoning, 'utf8') +
      Buffer.byteLength(JSON.stringify(this.toolCalls), 'utf8') +
      (this.outputChecks.length > 0 ? Buffer.byteLength(JSON.stringify(this.outputChecks), 'utf8') : 0)
    )
  }
}

function formatEvent(ev: StoredEvent, withoutId = false): string {
  const head = withoutId ? '' : `id: ${ev.id}\n`
  return `${head}event: ${ev.event}\ndata: ${ev.data}\n\n`
}
