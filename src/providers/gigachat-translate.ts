/**
 * OpenAI dialect ↔ GigaChat translator (SPEC §9.1).
 *
 * GigaChat is only partly OpenAI-compatible: it silently ignores the `tools` field (verified
 * live on GigaChat-2 / -Pro / -Max: the model answers "no access" or invents the
 * tool result); only its native `functions` / `function_call` format works.
 * The AI SDK sends the OpenAI format, so it is rewritten at the fetch boundary: the loop,
 * the contract and the other providers never know.
 *
 *   request:  tools → functions, tool_choice → function_call,
 *             assistant.tool_calls → function_call (arguments is an OBJECT),
 *             role: tool → role: function (+ name, content is valid JSON),
 *             user with parts → a content string + attachments (file ids from /files)
 *   response: function_call → tool_calls (arguments is a string),
 *             finish_reason function_call → tool_calls,
 *             usage.precached_prompt_tokens → OpenAI cached_tokens semantics
 *
 * GigaChat calls one function per answer (parallel tools: no, §9.2). The history
 * stays provider-agnostic: a turn with N parallel tool_calls from another model
 * is laid out as N sequential "function_call → function" pairs.
 */
import { randomUUID } from 'node:crypto'

type Json = Record<string, unknown>

interface OpenAiToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

/* ----------------------------------------------------------------- request */

/**
 * attachments: image data URL → file id in GigaChat storage. The upload is done by the
 * fetch wrapper before translation (gigachat.ts), so the translator itself stays pure.
 */
export function toGigachatRequest(body: Json, attachments: ReadonlyMap<string, string> = new Map()): Json {
  const { tools, tool_choice, stream_options: _streamOptions, parallel_tool_calls: _parallel, ...rest } = body
  const out: Json = { ...rest }

  if (Array.isArray(body.messages)) out.messages = translateMessages(body.messages as Json[], attachments)

  const functions = Array.isArray(tools)
    ? (tools as Json[])
        .map((t) => t.function as Json | undefined)
        .filter((f): f is Json => !!f && typeof f.name === 'string')
        .map((f) => ({
          name: f.name,
          ...(f.description ? { description: f.description } : {}),
          parameters: f.parameters ?? { type: 'object', properties: {} },
        }))
    : []

  if (functions.length > 0 && tool_choice !== 'none') {
    out.functions = functions
    out.function_call = functionCallMode(tool_choice)
  }
  return out
}

/** GigaChat has no `required`, the closest is `auto`; a named choice → { name }. */
function functionCallMode(toolChoice: unknown): unknown {
  const name = ((toolChoice as Json | undefined)?.function as Json | undefined)?.name
  return typeof name === 'string' ? { name } : 'auto'
}

/** The request's images (data URLs from user messages), deduplicated: they must be uploaded to /files. */
export function collectImageUrls(body: Json): string[] {
  const urls = new Set<string>()
  for (const msg of Array.isArray(body.messages) ? (body.messages as Json[]) : []) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Json[]) {
      const url = imageUrlOf(part)
      if (url) urls.add(url)
    }
  }
  return [...urls]
}

function imageUrlOf(part: Json): string | undefined {
  if (part.type !== 'image_url') return undefined
  const url = (part.image_url as Json | undefined)?.url
  return typeof url === 'string' ? url : undefined
}

function translateMessages(messages: Json[], attachments: ReadonlyMap<string, string>): Json[] {
  const out: Json[] = []
  const toolNames = new Map<string, string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const calls = msg.role === 'assistant' && Array.isArray(msg.tool_calls) ? (msg.tool_calls as OpenAiToolCall[]) : []

    if (calls.length > 0) {
      // this turn's results follow as role: tool; take them to lay them out in pairs
      const results = new Map<string, Json>()
      while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
        const result = messages[++i]!
        results.set(String(result.tool_call_id), result)
      }
      calls.forEach((call, index) => {
        const name = call.function?.name ?? 'unknown'
        if (call.id) toolNames.set(call.id, name)
        const { tool_calls: _toolCalls, ...assistant } = msg
        out.push({
          ...assistant,
          // the assistant text goes only with the first call, otherwise it is duplicated
          content: index === 0 && typeof msg.content === 'string' ? msg.content : '',
          function_call: { name, arguments: parseArguments(call.function?.arguments) },
        })
        const result = call.id ? results.get(call.id) : undefined
        if (result) out.push(functionResult(name, result.content))
      })
      continue
    }

    if (msg.role === 'tool') {
      // a tool message without its assistant turn nearby (trimmed history): name by id
      out.push(functionResult(toolNames.get(String(msg.tool_call_id)) ?? 'unknown', msg.content))
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      out.push(...userMessages(msg, attachments))
      continue
    }

    out.push(msg)
  }
  return out
}

/**
 * GigaChat content is a string only, an image is a file id in attachments, and per the
 * docs one per message. Several images are laid out as consecutive user messages
 * (verified live: the model sees them all), the order of parts is kept. Text
 * parts are joined: GigaChat does not accept an array of parts even without images.
 */
function userMessages(msg: Json, attachments: ReadonlyMap<string, string>): Json[] {
  const { content, ...rest } = msg
  const chunks: Array<{ texts: string[]; fileId?: string }> = [{ texts: [] }]
  for (const part of content as Json[]) {
    const current = chunks[chunks.length - 1]!
    if (part.type === 'text') {
      current.texts.push(typeof part.text === 'string' ? part.text : '')
      continue
    }
    const url = imageUrlOf(part)
    if (!url) continue
    const fileId = attachments.get(url)
    if (!fileId) throw new Error('GigaChat: image not uploaded to /files')
    if (current.fileId) chunks.push({ texts: [], fileId })
    else current.fileId = fileId
  }
  return chunks.map(({ texts, fileId }) => ({
    ...rest,
    content: texts.join('\n\n'),
    ...(fileId ? { attachments: [fileId] } : {}),
  }))
}

function functionResult(name: string, content: unknown): Json {
  return { role: 'function', name, content: ensureJson(content) }
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** content of role: function must be valid JSON; bare text (a tool error) is wrapped. */
function ensureJson(content: unknown): string {
  if (typeof content !== 'string') return JSON.stringify(content ?? null)
  try {
    JSON.parse(content)
    return content
  } catch {
    return JSON.stringify({ result: content })
  }
}

/* ---------------------------------------------------------------- response */

/** One response object or one SSE chunk: choices[].message | delta + usage. Mutates and returns it. */
export function fromGigachatPayload(payload: Json): Json {
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices as Json[]) {
      for (const key of ['message', 'delta'] as const) {
        const node = choice[key] as Json | undefined
        if (!node || typeof node !== 'object') continue
        delete node.functions_state_id
        const call = node.function_call as { name?: string; arguments?: unknown } | undefined
        if (!call) continue
        delete node.function_call
        node.tool_calls = [
          {
            index: 0,
            id: `call_${randomUUID().replace(/-/g, '')}`,
            type: 'function',
            function: {
              name: call.name ?? '',
              arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
            },
          },
        ]
      }
      if (choice.finish_reason === 'function_call') choice.finish_reason = 'tool_calls'
    }
  }

  const usage = payload.usage as Json | undefined
  if (usage && typeof usage === 'object') translateUsage(usage)
  return payload
}

/**
 * GigaChat: prompt_tokens is already WITHOUT cache, the cache comes separately in
 * precached_prompt_tokens. OpenAI: cached_tokens is INCLUDED in prompt_tokens (the engine
 * subtracts it later, §8.1).
 * Converted to OpenAI semantics so that accounting is uniform across the dialect.
 */
function translateUsage(usage: Json): void {
  const cached = usage.precached_prompt_tokens
  if (typeof cached !== 'number' || cached <= 0) return
  if (typeof usage.prompt_tokens === 'number') usage.prompt_tokens += cached
  if (typeof usage.total_tokens === 'number') usage.total_tokens += cached
  usage.prompt_tokens_details = { cached_tokens: cached }
}

/** Rewrites the SSE stream line by line; GigaChat's function_call arrives in one chunk. */
export function translateGigachatSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:')) return line
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return line
    try {
      return `data: ${JSON.stringify(fromGigachatPayload(JSON.parse(data) as Json))}`
    } catch {
      return line // not JSON: pass it through as is, the SDK decides
    }
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(rewriteLine).join('\n') + '\n'))
      },
      flush(controller) {
        buffer += decoder.decode()
        if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)))
      },
    }),
  )
}
