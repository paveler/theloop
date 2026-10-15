/**
 * MiniMax (SPEC §9.1): an Anthropic-compatible API through the real @ai-sdk/anthropic,
 * with the network replaced by a fake fetch. The key point is signed thinking: the SDK
 * puts it into providerMetadata.anthropic, while in the history it is tagged `minimax`
 * and never goes to Anthropic.
 */
import { describe, expect, it } from 'vitest'
import type { AssistantPart, Llm, StoredMessage } from '../src/contracts.js'
import type { EgressClient } from '../src/egress/client.js'
import { contextWindowFor, providerEntry } from '../src/providers/allowlist.js'
import { buildModel } from '../src/providers/factory.js'
import { toModelMessages } from '../src/runs/messages.js'
import { streamStep } from '../src/runs/provider.js'
import { testConfig } from './helpers.js'

const noImages = async () => {
  throw new Error('there must be no images')
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

/** Anthropic Messages API SSE: signed thinking, then text, then tool_use. */
function anthropicStream(): string {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M2.7',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'need the weather' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mm-sig-1' } }],
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
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function minimax(params: Record<string, unknown> = {}) {
  const sent: Sent[] = []
  const fakeFetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    sent.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(anthropicStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const egress = { assertAllowed: () => {}, providerFetchFor: () => fakeFetch } as unknown as EgressClient
  const llm = { provider: 'minimax', model: 'MiniMax-M2.7', api_key: 'mm-key', params } as unknown as Llm
  return { resolved: buildModel(llm, testConfig(), egress), sent }
}

async function step(resolved: ReturnType<typeof minimax>['resolved'], history: StoredMessage[]) {
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

const USER: StoredMessage = { role: 'user', content: [{ type: 'text', text: "what's the weather in London?" }] }

describe('minimax: allowlist and model build (SPEC §9.1)', () => {
  it('Anthropic dialect, built-in base_url, key in x-api-key', async () => {
    expect(providerEntry('minimax').kind).toBe('anthropic')
    const { resolved, sent } = minimax()
    expect(resolved.supportsCacheControl).toBe(true)
    await step(resolved, [USER])
    expect(sent[0]!.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(sent[0]!.headers['x-api-key']).toBe('mm-key')
    expect(sent[0]!.body.model).toBe('MiniMax-M2.7')
    expect(sent[0]!.body.max_tokens).toBe(16_000)
  })

  it('key from env MINIMAX_API_KEY when the request has none', () => {
    const egress = { assertAllowed: () => {}, providerFetchFor: () => fetch } as unknown as EgressClient
    const llm = { provider: 'minimax', model: 'MiniMax-M3', params: {} } as unknown as Llm
    expect(() => buildModel(llm, testConfig(), egress)).toThrow(
      expect.objectContaining({ code: 'provider_key_missing' }),
    )
    expect(() => buildModel(llm, testConfig({ MINIMAX_API_KEY: 'env-key' }), egress)).not.toThrow()
  })

  it.each([
    ['glm-5.3', 1_000_000],
    ['glm-5.3-flashx', 1_000_000],
    ['glm-5.2', 1_000_000],
    ['glm-5.1', 200_000],
    ['glm-4.7', 200_000],
    ['glm-4.7-flash', 200_000],
    ['glm-4.6v', 128_000],
    ['glm-4.5-air', 128_000],
    ['MiniMax-M3', 1_000_000],
    ['MiniMax-M3.1-Flash-Preview', 1_000_000],
    ['MiniMax-M2.7-highspeed', 204_800],
    ['MiniMax-M2', 204_800],
  ])('window of %s is %i (SPEC §5.1)', (model, size) => {
    expect(contextWindowFor(model, 128_000)).toBe(size)
  })

  it('thinking becomes adaptive without a budget (SPEC §9.3)', async () => {
    const { resolved, sent } = minimax({ thinking: { budget_tokens: 10_000 } })
    await step(resolved, [USER])
    expect(sent[0]!.body.thinking).toEqual({ type: 'adaptive' })
    // the budget is not added to max_tokens, unlike with enabled
    expect(sent[0]!.body.max_tokens).toBe(16_000)
  })

  it('without thinking the field is not sent', async () => {
    const { resolved, sent } = minimax()
    await step(resolved, [USER])
    expect(sent[0]!.body).not.toHaveProperty('thinking')
  })
})

describe('minimax: signed thinking round-trips through the history (SPEC §5.2)', () => {
  it('reasoning is stored with provider minimax and the signature; tool_call and usage are parsed', async () => {
    const { resolved } = minimax()
    const outcome = await step(resolved, [USER])
    expect(outcome.failure).toBeNull()
    expect(outcome.parts[0]).toEqual({
      type: 'reasoning',
      text: 'need the weather',
      provider: 'minimax',
      provider_metadata: { signature: 'mm-sig-1' },
    })
    expect(outcome.toolCalls).toEqual([
      expect.objectContaining({ callId: 'call_1', tool: 'getWeather', args: { city: 'London' } }),
    ])
    expect(outcome.finishReason).toBe('tool-calls')
    expect(outcome.usage?.cachedInputTokens).toBe(80)
  })

  it('the next step sends the MiniMax thinking block back unchanged', async () => {
    const { resolved, sent } = minimax()
    const first = await step(resolved, [USER])
    const assistant: StoredMessage = { role: 'assistant', content: first.parts }
    const tool: StoredMessage = {
      role: 'tool',
      call_id: 'call_1',
      tool: 'getWeather',
      result: { temperature_c: -3 },
      is_error: false,
    }
    await step(resolved, [USER, assistant, tool])

    const replayed = sent[1]!.body.messages[1]
    expect(replayed.role).toBe('assistant')
    expect(replayed.content[0]).toEqual({ type: 'thinking', thinking: 'need the weather', signature: 'mm-sig-1' })
    expect(replayed.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'getWeather' })
  })

  it('a MiniMax signature does not go to Anthropic, nor an Anthropic one to MiniMax', async () => {
    const part = (provider: string): AssistantPart => ({
      type: 'reasoning',
      text: 'thoughts',
      provider,
      provider_metadata: { signature: `${provider}-sig` },
    })
    const history: StoredMessage[] = [
      USER,
      { role: 'assistant', content: [part('minimax'), part('anthropic'), { type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ]
    for (const provider of ['minimax', 'anthropic']) {
      const converted = await toModelMessages(history, { provider, resolveImage: noImages })
      const parts = converted[1]!.content as Array<Record<string, any>>
      expect(parts.filter((p) => p.type === 'reasoning')).toEqual([
        { type: 'reasoning', text: 'thoughts', providerOptions: { anthropic: { signature: `${provider}-sig` } } },
      ])
    }
  })
})
