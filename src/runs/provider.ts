/**
 * One provider attempt (SPEC §11.3): streamText for ONE step.
 * The SDK loop (stopWhen / execute) is not used — we need control over retries, limits
 * and the moment tools are executed.
 *
 * Returns an outcome, not an exception: on a dropped stream we need the partial answer
 * and a "saw content" flag — after the first content event a transparent retry is impossible.
 */
import { APICallError, streamText, type LanguageModel, type ProviderMetadata, type ToolSet } from 'ai'
import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { LanguageModelUsage } from 'ai'
import type { AssistantPart } from '../contracts.js'
import type { ErrorCode } from '../errors.js'
import { texts, type Texts } from '../i18n.js'
import { redactSecrets } from '../log.js'
import { sdkKeyFor } from '../providers/allowlist.js'
import { GigachatOAuthError, isCertificateError } from '../providers/gigachat.js'
import { parseRetryAfter } from '../providers/throttle.js'

export interface ProviderFailure {
  /** failed — the provider refused before processing; unknown — it may have processed (SPEC §8.2). */
  kind: 'failed' | 'unknown'
  code: ErrorCode
  message: string
  providerStatus?: number
  providerBody?: string
  retriable: boolean
  /** Retry-After from the provider response, ms (SPEC §11.3) — 429 only. */
  retryAfterMs?: number
}

export interface StepToolCall {
  callId: string
  tool: string
  args: unknown
  /**
   * The SDK marked the call invalid: unparsable argument JSON or a
   * nonexistent tool. Such a call is NOT executed (SPEC §6.1) — the model
   * gets a tool-error and can rephrase.
   */
  invalid?: boolean
  invalidReason?: string
}

export interface StepOutcome {
  parts: AssistantPart[]
  text: string
  reasoningText: string
  toolCalls: StepToolCall[]
  finishReason: string | null
  usage: LanguageModelUsage | undefined
  providerMetadata: ProviderMetadata | undefined
  providerRequestId: string | null
  durationMs: number
  /** Whether at least one content event occurred: delta / reasoning / tool_call (SPEC §11.3). */
  sawContent: boolean
  aborted: boolean
  failure: ProviderFailure | null
}

export interface StreamStepParams {
  model: LanguageModel
  provider: string
  messages: ModelMessage[]
  tools: ToolSet
  /** 'none' — the model must answer with text, calling tools is not allowed (SPEC §6.7). */
  toolChoice?: 'none'
  maxTokens: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  seed?: number
  providerOptions: Record<string, Record<string, unknown>>
  /** Headers for the provider request — the GigaChat cache session (SPEC §9.1). */
  headers?: Record<string, string>
  abortSignal: AbortSignal
  onTextDelta: (text: string) => void
  onReasoningDelta: (text: string) => void
  onToolCall: (call: StepToolCall) => void
  /** Texts in the run's locale (SPEC Appendix B): invalid_tool_input reasons, error.message. */
  texts?: Texts
}

interface ReasoningBlock {
  index: number
  closed: boolean
}

export async function streamStep(params: StreamStepParams): Promise<StepOutcome> {
  const t = params.texts ?? texts()
  const started = Date.now()
  const parts: AssistantPart[] = []
  const textIndexById = new Map<string, number>()
  const reasoningById = new Map<string, ReasoningBlock>()
  const toolCalls: StepToolCall[] = []

  const outcome: StepOutcome = {
    parts,
    text: '',
    reasoningText: '',
    toolCalls,
    finishReason: null,
    usage: undefined,
    providerMetadata: undefined,
    providerRequestId: null,
    durationMs: 0,
    sawContent: false,
    aborted: false,
    failure: null,
  }

  try {
    const result = streamText({
      model: params.model,
      messages: params.messages,
      allowSystemInMessages: true,
      tools: params.tools,
      ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
      maxRetries: 0, // the engine retries itself and records every attempt (SPEC §8.1, §11.3)
      maxOutputTokens: params.maxTokens,
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.topP != null ? { topP: params.topP } : {}),
      ...(params.stopSequences ? { stopSequences: params.stopSequences } : {}),
      ...(params.seed != null ? { seed: params.seed } : {}),
      ...(Object.keys(params.providerOptions).length > 0
        ? { providerOptions: params.providerOptions as never }
        : {}),
      ...(params.headers ? { headers: params.headers } : {}),
      abortSignal: params.abortSignal,
      onError: () => {
        /* the error also arrives as part of the stream — handled there */
      },
    })

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case 'text-start': {
          textIndexById.set(chunk.id, parts.length)
          parts.push({ type: 'text', text: '' })
          break
        }
        case 'text-delta': {
          let index = textIndexById.get(chunk.id)
          if (index == null) {
            index = parts.length
            textIndexById.set(chunk.id, index)
            parts.push({ type: 'text', text: '' })
          }
          const part = parts[index] as { type: 'text'; text: string }
          part.text += chunk.text
          outcome.text += chunk.text
          if (chunk.text.length > 0) {
            outcome.sawContent = true
            params.onTextDelta(chunk.text)
          }
          break
        }
        case 'reasoning-start': {
          reasoningById.set(chunk.id, { index: parts.length, closed: false })
          parts.push({
            type: 'reasoning',
            text: '',
            provider: params.provider,
            provider_metadata: mergeMeta({}, chunk.providerMetadata, params.provider),
          })
          break
        }
        case 'reasoning-delta': {
          let block = reasoningById.get(chunk.id)
          if (!block) {
            block = { index: parts.length, closed: false }
            reasoningById.set(chunk.id, block)
            parts.push({
              type: 'reasoning',
              text: '',
              provider: params.provider,
              provider_metadata: {},
            })
          }
          const part = parts[block.index] as {
            type: 'reasoning'
            text?: string
            provider_metadata: Record<string, unknown>
          }
          part.text = (part.text ?? '') + chunk.text
          part.provider_metadata = mergeMeta(part.provider_metadata, chunk.providerMetadata, params.provider)
          outcome.reasoningText += chunk.text
          if (chunk.text.length > 0) {
            outcome.sawContent = true
            params.onReasoningDelta(chunk.text)
          }
          break
        }
        case 'reasoning-end': {
          const block = reasoningById.get(chunk.id)
          if (block) {
            block.closed = true
            const part = parts[block.index] as {
              type: 'reasoning'
              provider_metadata: Record<string, unknown>
            }
            part.provider_metadata = mergeMeta(part.provider_metadata, chunk.providerMetadata, params.provider)
          }
          break
        }
        case 'tool-call': {
          const invalid = (chunk as { invalid?: boolean }).invalid === true
          const call: StepToolCall = {
            callId: chunk.toolCallId,
            tool: chunk.toolName,
            args: chunk.input,
            ...(invalid
              ? { invalid: true, invalidReason: describeToolCallError((chunk as { error?: unknown }).error, t) }
              : {}),
          }
          toolCalls.push(call)
          parts.push({ type: 'tool_call', call_id: call.callId, tool: call.tool, args: call.args })
          outcome.sawContent = true
          params.onToolCall(call)
          break
        }
        case 'tool-error': {
          // the SDK sends tool-error right after an invalid tool-call — take the
          // human-readable reason
          const existing = toolCalls.find((c) => c.callId === chunk.toolCallId)
          if (existing) {
            existing.invalid = true
            existing.invalidReason = describeToolCallError(chunk.error, t)
          }
          break
        }
        case 'finish-step': {
          outcome.finishReason = chunk.finishReason
          outcome.usage = chunk.usage
          outcome.providerMetadata = chunk.providerMetadata
          outcome.providerRequestId = chunk.response?.id ?? null
          break
        }
        case 'abort': {
          outcome.aborted = true
          break
        }
        case 'error': {
          outcome.failure = classifyProviderError(chunk.error, t)
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    if (isAbortError(err, params.abortSignal)) {
      outcome.aborted = true
    } else {
      outcome.failure = classifyProviderError(err, t)
    }
  }

  // the abort may have arrived after the model already closed the stream
  if (params.abortSignal.aborted) outcome.aborted = true

  // the stream ended without finish-step and without an error — treat it as dropped: the
  // provider may have processed the request, the attempt counts as unknown (SPEC §8.2)
  if (!outcome.aborted && !outcome.failure && outcome.finishReason === null) {
    outcome.failure = {
      kind: 'unknown',
      code: 'provider_unavailable',
      message: t.streamWithoutFinish,
      retriable: true,
    }
  }

  // unclosed reasoning blocks without a signature are not kept (SPEC §5.2)
  for (const block of reasoningById.values()) {
    if (block.closed) continue
    const part = parts[block.index] as { provider_metadata?: Record<string, unknown> } | undefined
    if (part && Object.keys(part.provider_metadata ?? {}).length === 0) {
      parts[block.index] = { type: 'text', text: '' }
    }
  }
  outcome.parts = parts.filter(
    (p) => !(p.type === 'text' && p.text.length === 0) && !(p.type === 'reasoning' && !p.text && Object.keys(p.provider_metadata).length === 0),
  )

  outcome.durationMs = Date.now() - started
  return outcome
}

function describeToolCallError(error: unknown, t: Texts): string {
  if (error == null) return t.invalidCallArgs
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(message).slice(0, 300)
}

function mergeMeta(
  current: Record<string, unknown>,
  incoming: ProviderMetadata | undefined,
  provider: string,
): Record<string, unknown> {
  const slice = incoming?.[sdkKeyFor(provider)]
  if (!slice) return current
  return { ...current, ...(slice as Record<string, unknown>) }
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function findGigachatOAuthError(err: unknown): GigachatOAuthError | null {
  for (let e: unknown = err, depth = 0; e != null && depth < 4; depth++) {
    if (e instanceof GigachatOAuthError) return e
    e = (e as { cause?: unknown }).cause
  }
  return null
}

export function classifyProviderError(err: unknown, t: Texts = texts()): ProviderFailure {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0
    const body = err.responseBody ? redactSecrets(err.responseBody).slice(0, 2048) : undefined
    if (isContextTooLarge(status, err.responseBody ?? err.message)) {
      return {
        kind: 'failed',
        code: 'context_too_large',
        message: t.contextTooLarge,
        providerStatus: status,
        providerBody: body,
        retriable: false,
      }
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'failed',
        code: 'provider_auth',
        // 403 is not necessarily the key: Anthropic answers the same way to a request from
        // a blocked region (ANTHROPIC_PROXY_URL is needed, SPEC §11.4)
        message: status === 401 ? t.providerKeyRejected : t.providerForbidden,
        providerStatus: status,
        providerBody: body,
        retriable: false,
      }
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(err.responseHeaders)
      return {
        kind: 'failed',
        code: 'provider_rate_limited',
        message: t.providerRateLimited,
        providerStatus: status,
        providerBody: body,
        retriable: true,
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
      }
    }
    if (status >= 500) {
      return {
        kind: 'unknown',
        code: 'provider_unavailable',
        message: t.providerUnavailable(status),
        providerStatus: status,
        providerBody: body,
        retriable: true,
      }
    }
    if (status >= 400) {
      return {
        kind: 'failed',
        code: 'provider_error',
        message: t.providerRejected(status),
        providerStatus: status,
        providerBody: body,
        retriable: false,
      }
    }
    // no status — network error / dropped connection
    return {
      kind: 'unknown',
      code: 'provider_unavailable',
      message: redactSecrets(withRootCause(err.message, err)).slice(0, 512),
      retriable: true,
    }
  }

  // the SDK may wrap the fetch error in its own — look into cause as well
  const oauth = findGigachatOAuthError(err)
  if (oauth?.permanent) {
    return {
      kind: 'failed',
      code: 'provider_auth',
      message: redactSecrets(oauth.message).slice(0, 512),
      providerStatus: oauth.status,
      providerBody: oauth.responseBody ? redactSecrets(oauth.responseBody) : undefined,
      retriable: false,
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  if (isCertificateError(err)) {
    return {
      kind: 'failed',
      code: 'provider_unavailable',
      message: t.providerTls,
      retriable: false,
    }
  }
  if (isContextTooLarge(0, message)) {
    return {
      kind: 'failed',
      code: 'context_too_large',
      message: t.contextTooLarge,
      retriable: false,
    }
  }
  return {
    kind: 'unknown',
    code: 'provider_unavailable',
    message: redactSecrets(withRootCause(message, err)).slice(0, 512),
    retriable: true,
  }
}

/**
 * undici buries the cause of a network error 2–3 levels deep in cause ("fetch failed" →
 * "Request was cancelled." → "Proxy response (407)…"), and the AI SDK takes only
 * the first — append the deepest one, otherwise a proxy refusal is invisible in the log.
 */
function withRootCause(message: string, err: unknown): string {
  let root: string | undefined
  for (let e = (err as { cause?: unknown } | null)?.cause, depth = 0; e != null && depth < 6; depth++) {
    const m = (e as { message?: unknown }).message
    if (typeof m === 'string' && m) root = m
    e = (e as { cause?: unknown }).cause
  }
  return root && !message.includes(root) ? `${message} (${root})` : message
}

function isContextTooLarge(status: number, text: string | undefined): boolean {
  if (!text) return false
  return /context[_ ]?length|too many tokens|maximum context|context window|prompt is too long|context_too_large/i.test(
    text,
  )
}
