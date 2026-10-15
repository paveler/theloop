/**
 * Error webhook (SPEC §12.3): what would otherwise be visible only in container logs —
 * an undelivered callback, a crashed run, a missed ack, an unhandled exception —
 * is POSTed to ERROR_WEBHOOK_URL.
 *
 * Best-effort: one attempt, 5 s, no retries and no effect on the run — a webhook failure
 * is only logged. Goes through the egress client (the host must be in EGRESS_ALLOWLIST)
 * and is signed with the same X-Engine-Secret as the callback. The body carries no message
 * contents, prompts, tool args / results or keys — the same rules as for logs.
 */
import { ENGINE_SECRET_HEADER } from './config.js'
import { CONTRACT_VERSION } from './contracts.js'
import type { EgressClient } from './egress/client.js'
import { log, safeUrl } from './log.js'

export type AlertEvent = 'callback_failed' | 'run_failed' | 'ack_missing' | 'run_crashed' | 'unhandled_error'

const ALERT_TIMEOUT_MS = 5000
const ALERT_RESPONSE_MAX_BYTES = 65_536
/** Ceiling per window: an error storm must not turn into a request storm. */
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30

interface AlertSink {
  url: string
  secret: string | undefined
  egress: EgressClient
  version: string
}

let sink: AlertSink | null = null
let windowStart = 0
let sentInWindow = 0
let droppedInWindow = 0

export function configureAlerts(next: AlertSink | null): void {
  sink = next
  windowStart = 0
  sentInWindow = 0
  droppedInWindow = 0
}

export function sendAlert(event: AlertEvent, fields: Record<string, unknown>): void {
  const target = sink
  if (!target) return

  const now = Date.now()
  if (now - windowStart >= RATE_WINDOW_MS) {
    if (droppedInWindow > 0) log.warn('error_webhook_rate_limited', { dropped: droppedInWindow })
    windowStart = now
    sentInWindow = 0
    droppedInWindow = 0
  }
  if (sentInWindow >= RATE_MAX) {
    droppedInWindow++
    return
  }
  sentInWindow++

  const headers: Record<string, string> = {}
  if (target.secret) headers[ENGINE_SECRET_HEADER] = target.secret

  void target.egress
    .request({
      url: target.url,
      method: 'POST',
      headers,
      body: JSON.stringify({
        contract_version: CONTRACT_VERSION,
        event,
        at: new Date(now).toISOString(),
        engine_version: target.version,
        ...fields,
      }),
      timeoutMs: ALERT_TIMEOUT_MS,
      maxBytes: ALERT_RESPONSE_MAX_BYTES,
      purpose: 'error_webhook',
    })
    .then((res) => {
      if (res.status < 200 || res.status >= 300) {
        log.warn('error_webhook_failed', { event, status: res.status, url: safeUrl(target.url) })
      }
    })
    .catch((err) => {
      log.warn('error_webhook_failed', { event, err: String(err), url: safeUrl(target.url) })
    })
}
