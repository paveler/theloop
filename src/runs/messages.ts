/**
 * StoredMessage ↔ ModelMessage, context estimation and trimming (SPEC §5, §5.1, §5.3).
 *
 * Our own versioned DTO, not the AI SDK ModelMessage: reasoning with provider_metadata,
 * tool pairs and event parts live in the history and must survive a round trip.
 */
import type {
  AssistantModelMessage,
  ModelMessage,
  ProviderOptions,
  SystemModelMessage,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage,
} from '@ai-sdk/provider-utils'
import type { StoredMessage, ToolDef } from '../contracts.js'
import { EngineError } from '../errors.js'
import { sdkKeyFor } from '../providers/allowlist.js'
import { texts, type Texts } from '../i18n.js'

/* ------------------------------------------------------- token estimate */

/** A token ≈ 3 Cyrillic / 4 Latin characters, +10 % margin (SPEC §5.1). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cyrillic = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x0400 && code <= 0x04ff) cyrillic++
  }
  const divisor = cyrillic * 2 > text.length ? 3 : 4
  return Math.ceil((text.length / divisor) * 1.1)
}

export const IMAGE_TOKENS = 1600

/** Overhead of the service fields of one message. */
const MESSAGE_OVERHEAD_TOKENS = 4

export function estimateMessageTokens(message: StoredMessage): number {
  let sum = MESSAGE_OVERHEAD_TOKENS
  if (message.role === 'user') {
    for (const part of message.content) {
      if (part.type === 'text') sum += estimateTokens(part.text)
      else if (part.type === 'image') sum += IMAGE_TOKENS
      else sum += estimateTokens(eventToText(part.name, part.data))
    }
    return sum
  }
  if (message.role === 'assistant') {
    for (const part of message.content) {
      if (part.type === 'text') sum += estimateTokens(part.text)
      else if (part.type === 'reasoning') sum += estimateTokens(part.text ?? '')
      else sum += estimateTokens(part.tool) + estimateTokens(safeJson(part.args))
    }
    return sum
  }
  sum += estimateTokens(message.tool)
  if (message.is_error) sum += estimateTokens(message.error ?? '')
  else sum += estimateTokens(isEmptyToolResult(message.result) ? EMPTY_TOOL_RESULT : safeJson(message.result))
  return sum
}

export function estimateToolSchemaTokens(tools: readonly ToolDef[]): number {
  let sum = 0
  for (const tool of tools) {
    sum += estimateTokens(tool.name) + estimateTokens(tool.description ?? '')
    sum += estimateTokens(safeJson(tool.input_schema))
  }
  return sum
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable]'
  }
}

export function eventToText(name: string, data: unknown): string {
  return `[event ${name}] ${safeJson(data)}`
}

/** How many characters of one message to show in the log (history tail, SPEC §12.4). */
const DESCRIBE_MAX_CHARS = 600

/**
 * A message as one line for the log: `user: …`, `assistant: … → tool(args)`,
 * `tool name: result`. Not for the model — only to make the history readable by eye.
 */
export function describeMessage(message: StoredMessage): string {
  let text: string
  if (message.role === 'user') {
    text = message.content
      .map((part) =>
        part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : eventToText(part.name, part.data),
      )
      .join(' ')
  } else if (message.role === 'assistant') {
    text = message.content
      .map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'reasoning') return '[reasoning]'
        const op = part.operation_id ? ` op=${part.operation_id}` : ''
        return `→ ${part.tool}(${safeJson(part.args)})${op}`
      })
      .join(' ')
    if (message.partial) text = `[partial] ${text}`
  } else {
    const body = message.is_error ? `error: ${message.error ?? ''}` : safeJson(message.result)
    text = `${message.tool}#${message.call_id}: ${body}`
  }
  const line = `${message.role}: ${text}`
  return line.length > DESCRIBE_MAX_CHARS ? `${line.slice(0, DESCRIBE_MAX_CHARS)}…` : line
}

/* ------------------------------------------------------------ trimming */

export interface TrimInput {
  messages: StoredMessage[]
  systemTokens: number
  toolTokens: number
  /** Reserved for the model's answer. */
  reserveTokens: number
  contextWindow: number
}

export interface TrimResult {
  messages: StoredMessage[]
  trimmed: boolean
  estimatedTokens: number
}

/**
 * Block = turn: an assistant message with tool calls + its tool results (and the
 * reasoning of the same turn, which sits in the same assistant message). Dropped in
 * whole blocks so the §5 invariant is not broken.
 */
function toBlocks(messages: StoredMessage[]): StoredMessage[][] {
  const blocks: StoredMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && msg.content.some((p) => p.type === 'tool_call')) {
      const callIds = new Set(
        msg.content.filter((p) => p.type === 'tool_call').map((p) => (p as { call_id: string }).call_id),
      )
      const block: StoredMessage[] = [msg]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]!
        if (next.role !== 'tool' || !callIds.has(next.call_id)) break
        block.push(next)
        j++
      }
      blocks.push(block)
      i = j
    } else {
      blocks.push([msg])
      i++
    }
  }
  return blocks
}

export function trimHistory(input: TrimInput): TrimResult {
  const base = input.systemTokens + input.toolTokens + input.reserveTokens
  const total = (msgs: StoredMessage[]) =>
    base + msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)

  let current = input.messages
  let estimated = total(current)
  if (estimated <= input.contextWindow) {
    return { messages: current, trimmed: false, estimatedTokens: estimated }
  }

  const firstUserIndex = input.messages.findIndex((m) => m.role === 'user')
  const keepTailFrom = Math.max(0, input.messages.length - 4)
  const blocks = toBlocks(input.messages)

  // message indexes in the original array, to tell what is protected
  const indexOf = new Map<StoredMessage, number>()
  input.messages.forEach((m, idx) => indexOf.set(m, idx))

  const protectedBlock = (block: StoredMessage[]): boolean =>
    block.some((m) => {
      const idx = indexOf.get(m)!
      return idx === firstUserIndex || idx >= keepTailFrom
    })

  const alive = blocks.map((b) => ({ block: b, dropped: false }))
  let trimmed = false

  for (const item of alive) {
    if (estimated <= input.contextWindow) break
    if (protectedBlock(item.block)) continue
    item.dropped = true
    trimmed = true
    current = alive.filter((x) => !x.dropped).flatMap((x) => x.block)
    estimated = total(current)
  }

  return { messages: current, trimmed, estimatedTokens: estimated }
}

/* --------------------------------------------------- StoredMessage → SDK */

export type ImageResolver = (url: string) => Promise<{ data: Uint8Array; mediaType: string }>

export interface ConvertOptions {
  /** Provider id — reasoning from another provider is skipped (SPEC §5.2). */
  provider: string
  resolveImage: ImageResolver
  /**
   * Dates go into user messages (SPEC §9.4), not into system: a changing line in system
   * sits before the history and breaks the prefix cache on every turn. A user message
   * with `created_at` gets its own line from `created_at`, the same on any turn. An
   * `anchor` without `created_at` gets the current time `now`: the line lives one turn.
   */
  dates?: { timezone: string; anchor: StoredMessage | null; now: string }
  /**
   * cache_control on messages (SPEC §9.3): before the anchor's current time — this point
   * matches the next turn, where the message arrives without it — and on the prompt
   * tail, if the tail is not the anchor.
   */
  cacheBreakpoints?: boolean
  /** Engine texts in the run locale (SPEC Appendix B); absent — the default locale. */
  texts?: Texts
}

/** cache_control on top of the part's providerOptions: reasoning keeps its signature there, do not overwrite it. */
function withCacheControl(part: { providerOptions?: ProviderOptions }): void {
  const anthropic = part.providerOptions?.anthropic ?? {}
  part.providerOptions = {
    ...part.providerOptions,
    anthropic: { ...anthropic, cacheControl: { type: 'ephemeral' } },
  }
}

/**
 * tool_call ↔ tool pairs: checks the §5 invariant on run entry.
 * Checks not only that the paired message exists but also the order (a result cannot
 * precede its call — the provider rejects such a prompt) and that the tool name
 * matches: toolName goes into ToolResultPart, and a mismatch with the call breaks the turn.
 */
export function assertToolInvariant(messages: readonly StoredMessage[]): void {
  const pendingCalls = new Map<string, string>() // call_id → tool
  const answered = new Set<string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'tool_call') continue
        if (pendingCalls.has(part.call_id) || answered.has(part.call_id)) {
          throw new EngineError('unresolved_tool_call', 'call_id occurs twice in the history', {
            call_ids: [part.call_id],
          })
        }
        pendingCalls.set(part.call_id, part.tool)
      }
      continue
    }
    if (message.role !== 'tool') continue

    const expectedTool = pendingCalls.get(message.call_id)
    if (expectedTool === undefined) {
      throw new EngineError(
        'unresolved_tool_call',
        answered.has(message.call_id)
          ? 'the history already has a result for this call_id'
          : 'the tool result precedes its tool_call (or there is no call at all)',
        { call_ids: [message.call_id] },
      )
    }
    if (expectedTool !== message.tool) {
      throw new EngineError(
        'unresolved_tool_call',
        `tool name in the result does not match the call: ${message.tool} instead of ${expectedTool}`,
        { call_ids: [message.call_id] },
      )
    }
    pendingCalls.delete(message.call_id)
    answered.add(message.call_id)
  }

  if (pendingCalls.size > 0) {
    throw new EngineError('unresolved_tool_call', 'the history has a tool_call without a result', {
      call_ids: [...pendingCalls.keys()],
    })
  }
}

/**
 * The last message of the history is `user` or `tool` (SPEC §5): the model has something
 * to answer. A history ending on `assistant` means the client did not append the user's
 * turn, and the model "continues" its own turn — GigaChat, for example, with the service
 * token `<|superquote|>`. An assistant with a tool_call at the end never gets here —
 * assertToolInvariant catches it first.
 */
export function assertLastMessage(messages: readonly StoredMessage[]): void {
  if (messages.at(-1)?.role !== 'assistant') return
  throw new EngineError(
    'history_ends_with_assistant',
    'the history ends with an assistant message: no new user message or tool result',
  )
}

export async function toModelMessages(
  messages: readonly StoredMessage[],
  options: ConvertOptions,
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = []
  let anchorOut: ModelMessage | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      const content: Exclude<UserModelMessage['content'], string> = []
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text })
        } else if (part.type === 'event') {
          content.push({ type: 'text', text: eventToText(part.name, part.data) })
        } else {
          const image = await options.resolveImage(part.url)
          content.push({ type: 'image', image: image.data, mediaType: image.mediaType })
        }
      }
      const converted = { role: 'user', content } as UserModelMessage
      const dates = options.dates
      const own =
        dates && message.created_at ? messageDateLine(message.created_at, dates.timezone, options.texts) : null
      const cache = !!options.cacheBreakpoints
      if (own) {
        appendDate(content, own, { separate: cache, markBefore: false })
      } else if (dates && dates.anchor === message) {
        appendDate(content, dates.now, { separate: cache, markBefore: cache })
        anchorOut = converted
      }
      out.push(converted)
      continue
    }

    if (message.role === 'assistant') {
      const content: NonNullable<AssistantModelMessage['content']> = []
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text.length > 0) content.push({ type: 'text', text: part.text })
        } else if (part.type === 'tool_call') {
          content.push({
            type: 'tool-call',
            toolCallId: part.call_id,
            toolName: part.tool,
            input: part.args,
          })
        } else if (part.provider === options.provider) {
          // reasoning goes back to the provider as is (SPEC §5.2); the key is the one the
          // SDK adapter reads: for MiniMax it is `anthropic`
          content.push({
            type: 'reasoning',
            text: part.text ?? '',
            providerOptions: { [sdkKeyFor(part.provider)]: part.provider_metadata as never },
          })
        }
      }
      if (content.length === 0) continue
      out.push({ role: 'assistant', content } as AssistantModelMessage)
      continue
    }

    // tool: consecutive results are merged into one tool message —
    // providers (Anthropic) expect them as one block
    const resultPart: ToolResultPart = {
      type: 'tool-result',
      toolCallId: message.call_id,
      toolName: message.tool,
      output: message.is_error
        ? { type: 'error-text', value: message.error ?? 'tool error' }
        : toolOutput(message.result, options.texts),
    }
    const last = out[out.length - 1]
    if (last && last.role === 'tool') {
      ;(last.content as ToolResultPart[]).push(resultPart)
    } else {
      out.push({ role: 'tool', content: [resultPart] } as ToolModelMessage)
    }
  }

  // prompt tail: a tool step within the run and the next turn read everything sent
  // here from the cache. If the tail is the anchor with the current time, the point is already before it
  const last = out.at(-1)
  if (options.cacheBreakpoints && last && last !== anchorOut && Array.isArray(last.content)) {
    const part = last.content.at(-1)
    if (part) withCacheControl(part)
  }

  return out
}

/**
 * The date goes at the end of the user message (SPEC §9.4). With cache_control — as a
 * separate part, and the current time also gets a cache point at the boundary before it:
 * the next turn, where the message arrives without it, reads the cache up to that
 * boundary. Without cache_control — appended to the last text: a single-text message stays
 * a string, since not every openai-compatible API accepts part arrays; GigaChat joins texts
 * with a blank line on its own anyway.
 */
function appendDate(
  content: Exclude<UserModelMessage['content'], string>,
  dateLine: string,
  mode: { separate: boolean; markBefore: boolean },
): void {
  const last = content.at(-1)
  if (mode.separate) {
    if (last && mode.markBefore) withCacheControl(last)
    content.push({ type: 'text', text: dateLine })
  } else if (last?.type === 'text') {
    content[content.length - 1] = { ...last, text: `${last.text}\n\n${dateLine}` }
  } else {
    content.push({ type: 'text', text: dateLine })
  }
}

/**
 * What the model sees instead of an empty result (SPEC §6.2) — in the default locale;
 * within a run — `texts.emptyToolResult` of its locale. A bare `null` or an empty string
 * reads as "the call failed" — the model repeats it until max_steps.
 */
export const EMPTY_TOOL_RESULT = texts().emptyToolResult

/** Empty: an empty body, null, a whitespace-only string, [] or {}. */
export function isEmptyToolResult(result: unknown): boolean {
  if (result === undefined || result === null) return true
  if (typeof result === 'string') return result.trim().length === 0
  if (Array.isArray(result)) return result.length === 0
  if (typeof result === 'object') return Object.keys(result).length === 0
  return false
}

function toolOutput(result: unknown, t: Texts = texts()): ToolResultPart['output'] {
  if (isEmptyToolResult(result)) return { type: 'text', value: t.emptyToolResult }
  if (typeof result === 'string') return { type: 'text', value: result }
  return { type: 'json', value: result as never }
}

/**
 * System messages (SPEC §9.3, §9.4). The current time lands here only if the history has
 * no user message (`dateLine` is not null) — normally it goes into user messages. With
 * cache_control (Anthropic) — the prompt as a cacheable block, the date separately without
 * cache. Without cache_control — ONE message: GigaChat answers 422 to a second system
 * message ("system message must be the first message").
 */
export function buildSystemMessages(
  system: string | null | undefined,
  dateLine: string | null,
  cacheable: boolean,
): SystemModelMessage[] {
  const hasSystem = !!system && system.trim().length > 0
  if (!cacheable) {
    const content = [hasSystem ? system! : null, dateLine].filter((s) => s !== null).join('\n\n')
    return content ? [{ role: 'system', content }] : []
  }
  const out: SystemModelMessage[] = []
  if (hasSystem) {
    out.push({
      role: 'system',
      content: system!,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
  }
  if (dateLine) out.push({ role: 'system', content: dateLine })
  return out
}

/** `[engine] Current date and time: … (TZ).` (SPEC §9.4) */
export function engineDateLine(timezone: string, now: Date = new Date(), t: Texts = texts()): string {
  return t.currentDate(formatStamp(now, timezone), timezone)
}

/**
 * `[engine] Message date and time: … (TZ).` — from the user message's `created_at`
 * (SPEC §9.4). The text does not depend on the turn: the history is only appended to. An
 * invalid `created_at` → null, the message stays without a date.
 */
export function messageDateLine(createdAt: string, timezone: string, t: Texts = texts()): string | null {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null
  return t.messageDate(formatStamp(date, timezone), timezone)
}

function formatStamp(date: Date, timezone: string): string {
  try {
    return formatOffsetIso(date, timezone)
  } catch {
    return date.toISOString()
  }
}

function formatOffsetIso(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const offset = (parts.timeZoneName ?? 'GMT+00:00').replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}
