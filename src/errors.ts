/**
 * Error codes and their HTTP statuses (SPEC §12.1).
 * Error body — { error: { code, message, retriable } } plus optional details.
 */

export type ErrorCode =
  // 400 / 401
  | 'bad_request'
  | 'unresolved_tool_call'
  | 'history_ends_with_assistant'
  | 'write_context_missing'
  | 'egress_denied'
  | 'unauthorized'
  | 'provider_not_allowed'
  | 'provider_key_missing'
  | 'unsupported_media_type'
  | 'image_too_large'
  // 409
  | 'session_busy'
  | 'result_pending'
  | 'idempotency_mismatch'
  | 'result_mismatch'
  | 'not_finished'
  | 'call_closed'
  // 413 / 429 / 503
  | 'payload_too_large'
  | 'overloaded'
  | 'shutting_down'
  // 404
  | 'run_not_found'
  | 'call_not_found'
  // a run's terminal failures (never sent as an HTTP response code)
  | 'image_fetch_failed'
  | 'provider_stream_interrupted'
  | 'provider_auth'
  | 'provider_rate_limited'
  | 'provider_queue_timeout'
  | 'provider_unavailable'
  | 'provider_error'
  | 'context_too_large'
  | 'run_timeout'
  | 'internal_error'

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unresolved_tool_call: 400,
  history_ends_with_assistant: 400,
  write_context_missing: 400,
  egress_denied: 400,
  unauthorized: 401,
  provider_not_allowed: 400,
  provider_key_missing: 400,
  unsupported_media_type: 400,
  image_too_large: 400,
  session_busy: 409,
  result_pending: 409,
  idempotency_mismatch: 409,
  result_mismatch: 409,
  not_finished: 409,
  call_closed: 409,
  payload_too_large: 413,
  overloaded: 429,
  shutting_down: 503,
  run_not_found: 404,
  call_not_found: 404,
  image_fetch_failed: 500,
  provider_stream_interrupted: 500,
  provider_auth: 500,
  provider_rate_limited: 500,
  provider_queue_timeout: 500,
  provider_unavailable: 500,
  provider_error: 500,
  context_too_large: 500,
  run_timeout: 500,
  internal_error: 500,
}

const RETRIABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'session_busy',
  'result_pending',
  'overloaded',
  'shutting_down',
  'image_fetch_failed',
  'provider_stream_interrupted',
  'provider_rate_limited',
  'provider_queue_timeout',
  'provider_unavailable',
  'run_timeout',
])

export interface ErrorBody {
  code: ErrorCode
  message: string
  retriable: boolean
  [k: string]: unknown
}

export class EngineError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.details = details
  }

  get status(): number {
    return HTTP_STATUS[this.code]
  }

  get retriable(): boolean {
    return RETRIABLE.has(this.code)
  }

  toBody(): { error: ErrorBody } {
    return {
      error: { code: this.code, message: this.message, retriable: this.retriable, ...this.details },
    }
  }
}

export function isRetriableCode(code: ErrorCode): boolean {
  return RETRIABLE.has(code)
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code]
}
