/**
 * Kimi (SPEC §9.1): an Anthropic-compatible API through the real @ai-sdk/anthropic,
 * with the network replaced by a fake fetch. K3 always thinks; its thinking blocks come
 * unsigned, and the next step of a tool loop must still get them back.
 */
import { describe, expect, it } from 'vitest'
import type { Llm, StoredMessage } from '../src/contracts.js'
import type { EgressClient } from '../src/egress/client.js'
import { contextWindowFor, providerEntry } from '../src/providers/allowlist.js'
import { buildModel } from '../src/providers/factory.js'
import { toModelMessages } from '../src/runs/messages.js'
import { streamStep } from '../src/runs/provider.js'
import { normalizeUsage } from '../src/runs/usage.js'
import { testConfig } from './helpers.js'

const noImages = async () => {
  throw new Error('there must be no images')
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

/**
 * The SSE Kimi sends (captured live): thinking whose empty signature comes only in
 * content_block_start, never as a signature_delta, then two tool_use.
 */
function kimiStream(): string {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl-1',
          type: 'message',
          role: 'assistant',
          model: 'kimi-k3.1-pro',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 256 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'two cities' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'getWeather', input: {} } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"London"}' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_2', name: 'getWeather', input: {} } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function kimi(params: Record<string, unknown> = {}, model = 'kimi-k3.1-pro') {
  const sent: Sent[] = []
  const fakeFetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    sent.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(kimiStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const egress = { assertAllowed: () => {}, providerFetchFor: () => fakeFetch } as unknown as EgressClient
  const llm = { provider: 'kimi', model, api_key: 'sk-kimi', params } as unknown as Llm
  return { resolved: buildModel(llm, testConfig(), egress), sent }
}

async function step(resolved: ReturnType<typeof kimi>['resolved'], history: StoredMessage[]) {
  return streamStep({
    model: resolved.model,
    provider: resolved.providerId,
    messages: await toModelMessages(history, { provider: resolved.providerId, resolveImage: noImages }),
    tools: {},
    maxTokens: 16_000,
    providerOptions: resolved.providerOptions,
    abortSignal: new AbortController().signal,
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onToolCall: () => {},
  })
}

const USER: StoredMessage = { role: 'user', content: [{ type: 'text', text: 'weather in London and Paris?' }] }

describe('kimi: allowlist and model build (SPEC §9.1)', () => {
  it('Anthropic dialect, built-in base_url, key in x-api-key', async () => {
    expect(providerEntry('kimi').kind).toBe('anthropic')
    const { resolved, sent } = kimi()
    expect(resolved.supportsCacheControl).toBe(true)
    expect(resolved.capabilities.parallel_tools).toBe(true)
    expect(resolved.toolReferences).toBe(false)
    await step(resolved, [USER])
    expect(sent[0]!.url).toBe('https://api.moonshot.ai/anthropic/v1/messages')
    expect(sent[0]!.headers['x-api-key']).toBe('sk-kimi')
    expect(sent[0]!.body.model).toBe('kimi-k3.1-pro')
    expect(sent[0]!.body.max_tokens).toBe(16_000)
  })

  it('key from env KIMI_API_KEY when the request has none', () => {
    const egress = { assertAllowed: () => {}, providerFetchFor: () => fetch } as unknown as EgressClient
    const llm = { provider: 'kimi', model: 'kimi-k3', params: {} } as unknown as Llm
    expect(() => buildModel(llm, testConfig(), egress)).toThrow(expect.objectContaining({ code: 'provider_key_missing' }))
    expect(() => buildModel(llm, testConfig({ KIMI_API_KEY: 'env-key' }), egress)).not.toThrow()
  })

  it.each([
    ['kimi-k3', 1_048_576],
    ['kimi-k3.1-pro', 1_048_576],
    ['kimi-k3.1-pro-highspeed', 1_048_576],
  ])('window of %s is %i (SPEC §5.1)', (model, size) => {
    expect(contextWindowFor(model, 128_000)).toBe(size)
  })

  it('sampling is not sent: K3 has it fixed (SPEC §9.3)', () => {
    expect(kimi({ temperature: 0.3 }).resolved.acceptsSampling).toBe(false)
  })
})

describe('kimi: thinking depth through output_config.effort (SPEC §9.3)', () => {
  it.each([
    [undefined, 'low'],
    [{ budget_tokens: 1_000 }, 'low'],
    [{ budget_tokens: 4_000 }, 'high'],
    [{ budget_tokens: 16_000 }, 'max'],
  ])('thinking %j → effort %s, no thinking field', async (thinking, effort) => {
    const { resolved, sent } = kimi(thinking ? { thinking } : {})
    await step(resolved, [USER])
    expect(sent[0]!.body.output_config).toEqual({ effort })
    expect(sent[0]!.body).not.toHaveProperty('thinking')
    expect(sent[0]!.body.max_tokens).toBe(16_000)
  })
})

describe('kimi: thinking with an empty signature round-trips (SPEC §5.2)', () => {
  it('reasoning is stored with provider kimi; parallel tool calls and usage are parsed', async () => {
    const { resolved } = kimi()
    const outcome = await step(resolved, [USER])
    expect(outcome.failure).toBeNull()
    expect(outcome.parts[0]).toEqual({
      type: 'reasoning',
      text: 'two cities',
      provider: 'kimi',
      provider_metadata: { signature: '' },
    })
    expect(outcome.toolCalls).toEqual([
      expect.objectContaining({ callId: 'call_1', tool: 'getWeather', args: { city: 'London' } }),
      expect.objectContaining({ callId: 'call_2', tool: 'getWeather', args: { city: 'Paris' } }),
    ])
    expect(normalizeUsage(outcome.usage)).toMatchObject({ input_tokens: 10, cache_write_tokens: 256 })
  })

  it('the next step sends the thinking block back with the empty signature', async () => {
    const { resolved, sent } = kimi()
    const first = await step(resolved, [USER])
    const tool = (callId: string, city: string): StoredMessage => ({
      role: 'tool',
      call_id: callId,
      tool: 'getWeather',
      result: { city, temperature_c: 5 },
      is_error: false,
    })
    await step(resolved, [USER, { role: 'assistant', content: first.parts }, tool('call_1', 'London'), tool('call_2', 'Paris')])

    const replayed = sent[1]!.body.messages[1]
    expect(replayed.content[0]).toEqual({ type: 'thinking', thinking: 'two cities', signature: '' })
    expect(replayed.content.slice(1).map((p: { id: string }) => p.id)).toEqual(['call_1', 'call_2'])
  })
})
