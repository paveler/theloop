/**
 * An inbox message right after tool results (SPEC §4.11) must give a valid provider request:
 * the history is never rewritten, the SDK adapters do the role packing. Checked on the real
 * request bodies of the Anthropic and OpenAI-compatible adapters and of the GigaChat dialect.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { jsonSchema, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../src/contracts.js'
import { toModelMessages } from '../src/runs/messages.js'
import { toGigachatRequest } from '../src/providers/gigachat-translate.js'

const noImages = async () => {
  throw new Error('no images')
}

const history: StoredMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'status of order 1?' }], created_at: '2026-11-22T10:00:00Z' },
  { role: 'assistant', content: [{ type: 'tool_call', call_id: 'c1', tool: 'getStatus', args: { id: '1' } }] },
  { role: 'tool', call_id: 'c1', tool: 'getStatus', result: { status: 'shipped' }, is_error: false },
  {
    role: 'user',
    id: 'msg_2',
    injected: true,
    created_at: '2026-11-22T10:00:05Z',
    content: [{ type: 'event', name: 'task_done', data: { task_id: 't_1' } }],
  },
]

const tools = {
  getStatus: tool({ description: 'status', inputSchema: jsonSchema({ type: 'object', properties: { id: { type: 'string' } } }) }),
}

/** One streamText call against a fetch that records the body and fails: only the payload matters. */
async function capture(model: Parameters<typeof streamText>[0]['model'], messages: Awaited<ReturnType<typeof toModelMessages>>) {
  const result = streamText({ model, messages, tools, maxRetries: 0, onError: () => {} })
  await Promise.resolve(result.consumeStream()).catch(() => {})
}

function recordingFetch(sink: { body: any }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    sink.body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('inbox message after tool results: provider payloads (SPEC §4.11)', () => {
  it('Anthropic: tool_result first, then the message, in one user turn; roles alternate', async () => {
    const sink = { body: null as any }
    const model = createAnthropic({ apiKey: 'k', fetch: recordingFetch(sink) })('claude-sonnet-5')
    const messages = await toModelMessages(history, { provider: 'anthropic', resolveImage: noImages })
    await capture(model, messages)
    const roles = sink.body.messages.map((m: any) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user'])
    const last = sink.body.messages[2].content
    expect(last[0].type).toBe('tool_result')
    expect(last.slice(1).some((b: any) => b.type === 'text' && b.text.includes('task_done'))).toBe(true)
  })

  it('OpenAI-compatible and GigaChat: tool → user is a valid sequence', async () => {
    const sink = { body: null as any }
    const model = createOpenAICompatible({ name: 'x', baseURL: 'https://api.example.com/v1', apiKey: 'k', fetch: recordingFetch(sink) })('m')
    const messages = await toModelMessages(history, { provider: 'openai-compatible', resolveImage: noImages })
    await capture(model, messages)
    const roles = sink.body.messages.map((m: any) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(JSON.stringify(sink.body.messages[3])).toContain('task_done')

    const giga = toGigachatRequest(sink.body) as any
    expect(giga.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'function', 'user'])
  })
})
