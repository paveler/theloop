import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, jsonSchema, tool } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'
import { gigachatFetch, resetGigachatTokenCache } from '../src/providers/gigachat.js'
import {
  fromGigachatPayload,
  toGigachatRequest,
  translateGigachatSse,
} from '../src/providers/gigachat-translate.js'

const weatherTool = {
  type: 'function',
  function: {
    name: 'getWeather',
    description: 'Weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}

describe('request: OpenAI dialect → GigaChat (SPEC §9.1)', () => {
  it('tools → functions, function_call: auto, extra OpenAI fields removed', () => {
    const out = toGigachatRequest({
      model: 'GigaChat-2-Pro',
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
      tools: [weatherTool],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
    expect(out.stream_options).toBeUndefined()
    expect(out.parallel_tool_calls).toBeUndefined()
    expect(out.function_call).toBe('auto')
    expect(out.functions).toEqual([
      { name: 'getWeather', description: 'Weather', parameters: weatherTool.function.parameters },
    ])
    expect(out.stream).toBe(true)
  })

  it('tool_choice: named → { name }, none → no functions, required → auto', () => {
    const named = toGigachatRequest({
      tools: [weatherTool],
      tool_choice: { type: 'function', function: { name: 'getWeather' } },
    })
    expect(named.function_call).toEqual({ name: 'getWeather' })

    const none = toGigachatRequest({ tools: [weatherTool], tool_choice: 'none' })
    expect(none.functions).toBeUndefined()
    expect(none.function_call).toBeUndefined()

    expect(toGigachatRequest({ tools: [weatherTool], tool_choice: 'required' }).function_call).toBe('auto')
  })

  it('leaves a request without tools untouched', () => {
    const out = toGigachatRequest({ model: 'GigaChat-2', messages: [{ role: 'user', content: 'a' }] })
    expect(out).toEqual({ model: 'GigaChat-2', messages: [{ role: 'user', content: 'a' }] })
  })

  it('assistant.tool_calls → function_call with an OBJECT, role tool → function with a name', () => {
    const out = toGigachatRequest({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"Berlin"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temperature_c":-3}' },
      ],
    })
    expect(out.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', function_call: { name: 'getWeather', arguments: { city: 'Berlin' } } },
      { role: 'function', name: 'getWeather', content: '{"temperature_c":-3}' },
    ])
  })

  it('a bare-text result (tool error) is wrapped in valid JSON', () => {
    const out = toGigachatRequest({
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'tool timeout' },
      ],
    })
    const result = (out.messages as Array<{ content: string }>)[1]!
    expect(JSON.parse(result.content)).toEqual({ result: 'tool timeout' })
  })

  it('parallel tool_calls from a foreign history → sequential pairs', () => {
    const out = toGigachatRequest({
      messages: [
        {
          role: 'assistant',
          content: 'Checking both cities.',
          tool_calls: [
            { id: 'a', function: { name: 'getWeather', arguments: '{"city":"Berlin"}' } },
            { id: 'b', function: { name: 'getWeather', arguments: '{"city":"Paris"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '{"t":-3}' },
        { role: 'tool', tool_call_id: 'b', content: '{"t":1}' },
        { role: 'user', content: 'thanks' },
      ],
    })
    const msgs = out.messages as Array<Record<string, unknown>>
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'function', 'assistant', 'function', 'user'])
    expect(msgs[0]!.content).toBe('Checking both cities.')
    expect(msgs[2]!.content).toBe('') // the text is not duplicated
    expect(msgs[1]!.content).toBe('{"t":-3}')
    expect(msgs[3]!.content).toBe('{"t":1}')
  })

  it('broken arguments do not crash the request', () => {
    const out = toGigachatRequest({
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{oops' } }] }],
    })
    expect((out.messages as Array<{ function_call: { arguments: unknown } }>)[0]!.function_call.arguments).toEqual({})
  })
})

describe('response: GigaChat → OpenAI dialect', () => {
  it('function_call → tool_calls with string arguments, finish_reason → tool_calls', () => {
    const out = fromGigachatPayload({
      choices: [
        {
          index: 0,
          finish_reason: 'function_call',
          message: {
            role: 'assistant',
            content: '',
            function_call: { name: 'getWeather', arguments: { city: 'Berlin' } },
            functions_state_id: 'state-1',
          },
        },
      ],
    }) as { choices: Array<{ finish_reason: string; message: Record<string, unknown> }> }
    const choice = out.choices[0]!
    expect(choice.finish_reason).toBe('tool_calls')
    expect(choice.message.function_call).toBeUndefined()
    expect(choice.message.functions_state_id).toBeUndefined()
    const [call] = choice.message.tool_calls as Array<{ id: string; index: number; type: string; function: { name: string; arguments: string } }>
    expect(call!.id).toMatch(/^call_[0-9a-f]{32}$/)
    expect(call!.index).toBe(0)
    expect(call!.type).toBe('function')
    expect(call!.function).toEqual({ name: 'getWeather', arguments: '{"city":"Berlin"}' })
  })

  it('usage: precached_prompt_tokens → OpenAI semantics (the cache is part of prompt_tokens)', () => {
    // as observed from the live API: 1 uncached + 749 from the cache
    const out = fromGigachatPayload({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4, precached_prompt_tokens: 749 },
    }) as { usage: Record<string, unknown> }
    expect(out.usage.prompt_tokens).toBe(750)
    expect(out.usage.total_tokens).toBe(753)
    expect(out.usage.prompt_tokens_details).toEqual({ cached_tokens: 749 })
  })

  it('a plain text response is unchanged', () => {
    const payload = { choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'hello' } }] }
    expect(fromGigachatPayload(structuredClone(payload))).toEqual(payload)
  })
})

function sseStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p))
      controller.close()
    },
  })
}

// a non-ASCII city on purpose: the SSE test tears the stream inside a multi-byte character
const FUNCTION_CHUNK =
  'data: {"choices":[{"delta":{"content":"","role":"assistant","function_call":{"name":"getWeather","arguments":{"city":"Zürich"}},"functions_state_id":"s1"},"index":0,"finish_reason":"function_call"}],"usage":{"prompt_tokens":10,"completion_tokens":23,"total_tokens":33,"precached_prompt_tokens":70}}\n\n'

describe('SSE stream', () => {
  it('rewrites a chunk torn mid-line and mid-UTF-8 character', async () => {
    const bytes = new TextEncoder().encode(FUNCTION_CHUNK + 'data: [DONE]\n\n')
    // inside the JSON, between the two bytes of "ü": the cut is by bytes, not by characters
    const cut = new TextEncoder().encode(FUNCTION_CHUNK.slice(0, FUNCTION_CHUNK.indexOf('ü'))).length + 1
    expect(bytes[cut - 1]).toBe(0xc3)
    const stream = translateGigachatSse(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, cut))
          c.enqueue(bytes.slice(cut))
          c.close()
        },
      }),
    )
    const text = await new Response(stream).text()
    const lines = text.split('\n').filter(Boolean)
    expect(lines.at(-1)).toBe('data: [DONE]')
    const chunk = JSON.parse(lines[0]!.slice(6))
    expect(chunk.choices[0].finish_reason).toBe('tool_calls')
    expect(chunk.choices[0].delta.tool_calls[0].function).toEqual({ name: 'getWeather', arguments: '{"city":"Zürich"}' })
    expect(chunk.usage.prompt_tokens).toBe(80)
  })
})

describe('gigachatFetch + AI SDK: end to end without network', () => {
  beforeEach(() => resetGigachatTokenCache())

  it('the SDK sends tools, GigaChat gets functions, the SDK sees a tool call', async () => {
    const sent: Array<Record<string, unknown>> = []
    const mock: typeof fetch = async (input, init) => {
      if (String(input).includes('oauth')) {
        return Response.json({ access_token: 't', expires_at: Date.now() + 30 * 60_000 })
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(sseStream([FUNCTION_CHUNK, 'data: [DONE]\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const model = createOpenAICompatible({
      name: 'gigachat',
      baseURL: 'https://gigachat.devices.sberbank.ru/api/v1',
      includeUsage: true,
      fetch: gigachatFetch('KEY', 'GIGACHAT_API_PERS', mock),
    })('GigaChat-2-Pro')

    const result = streamText({
      model,
      maxRetries: 0,
      messages: [{ role: 'user', content: 'Weather in Zürich?' }],
      tools: {
        getWeather: tool({
          description: 'Weather',
          inputSchema: jsonSchema({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }),
        }),
      },
    })
    const calls = await result.toolCalls
    const usage = await result.usage

    expect(sent[0]!.tools).toBeUndefined()
    expect((sent[0]!.functions as Array<{ name: string }>)[0]!.name).toBe('getWeather')
    expect(sent[0]!.function_call).toBe('auto')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe('getWeather')
    expect(calls[0]!.input).toEqual({ city: 'Zürich' })
    expect(await result.finishReason).toBe('tool-calls')
    expect(usage.inputTokens).toBe(80)
    expect(usage.cachedInputTokens).toBe(70)
  })

  it('non-chat requests (/models) and provider errors pass through untranslated', async () => {
    const mock: typeof fetch = async (input) => {
      if (String(input).includes('oauth')) {
        return Response.json({ access_token: 't', expires_at: Date.now() + 30 * 60_000 })
      }
      return new Response('{"status":422,"message":"bad"}', { status: 422 })
    }
    const f = gigachatFetch('KEY', 'GIGACHAT_API_PERS', mock)
    const res = await f('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toBe('{"status":422,"message":"bad"}')
  })
})
