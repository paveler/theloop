import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../src/contracts.js'
import { EngineError } from '../src/errors.js'
import { texts } from '../src/i18n.js'
import {
  assertLastMessage,
  assertToolInvariant,
  buildSystemMessages,
  EMPTY_TOOL_RESULT,
  engineDateLine,
  messageDateLine,
  estimateTokens,
  isEmptyToolResult,
  toModelMessages,
  trimHistory,
} from '../src/runs/messages.js'
import { parseDataUrl } from '../src/runs/images.js'

const noImages = async () => {
  throw new Error('there must be no images')
}

describe('token estimate (SPEC §5.1)', () => {
  it('Cyrillic counts 3 chars per token, Latin 4', () => {
    const cyr = 'абвабвабвабвабвабвабвабвабвабв' // 30 chars
    const lat = 'abcabcabcabcabcabcabcabcabcabc' // 30 chars
    expect(estimateTokens(cyr)).toBe(Math.ceil((30 / 3) * 1.1))
    expect(estimateTokens(lat)).toBe(Math.ceil((30 / 4) * 1.1))
    expect(estimateTokens('')).toBe(0)
  })
})

describe('StoredMessage → ModelMessage (SPEC §5)', () => {
  it('tool pairs merge into one tool message, is_error gives error-text', async () => {
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'status?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', call_id: 'c1', tool: 'getStatus', args: { id: '1' } },
          { type: 'tool_call', call_id: 'c2', tool: 'getStatus', args: { id: '2' } },
        ],
      },
      { role: 'tool', call_id: 'c1', tool: 'getStatus', result: { ok: true }, is_error: false },
      { role: 'tool', call_id: 'c2', tool: 'getStatus', error: 'access denied', is_error: true },
    ]

    const converted = await toModelMessages(history, { provider: 'anthropic', resolveImage: noImages })
    expect(converted).toHaveLength(3)
    expect(converted[2]!.role).toBe('tool')
    const parts = converted[2]!.content as Array<Record<string, any>>
    expect(parts).toHaveLength(2)
    expect(parts[0]!.output).toEqual({ type: 'json', value: { ok: true } })
    expect(parts[1]!.output).toEqual({ type: 'error-text', value: 'access denied' })
  })

  it('the model sees an empty tool result as an explicit marker, not null / an empty string', async () => {
    const empties: unknown[] = [null, undefined, '', '  \n', [], {}]
    for (const result of empties) {
      const history: StoredMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'find it' }] },
        { role: 'assistant', content: [{ type: 'tool_call', call_id: 'c1', tool: 'search', args: {} }] },
        { role: 'tool', call_id: 'c1', tool: 'search', result, is_error: false },
      ]
      const converted = await toModelMessages(history, { provider: 'anthropic', resolveImage: noImages })
      const parts = converted[2]!.content as Array<Record<string, any>>
      expect(parts[0]!.output).toEqual({ type: 'text', value: EMPTY_TOOL_RESULT })
    }
  })

  it('non-empty values are not empty: 0, false, [0], { a: null }', () => {
    for (const value of [0, false, 'x', [0], { a: null }]) expect(isEmptyToolResult(value)).toBe(false)
  })

  it('reasoning goes back to its own provider and is skipped for another one', async () => {
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'think' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'thoughts',
            provider: 'anthropic',
            provider_metadata: { signature: 'sig-1' },
          },
          { type: 'text', text: 'answer' },
        ],
      },
    ]

    const own = await toModelMessages(history, { provider: 'anthropic', resolveImage: noImages })
    const ownParts = own[1]!.content as Array<Record<string, any>>
    expect(ownParts[0]).toEqual({
      type: 'reasoning',
      text: 'thoughts',
      providerOptions: { anthropic: { signature: 'sig-1' } },
    })

    const alien = await toModelMessages(history, { provider: 'gigachat', resolveImage: noImages })
    const alienParts = alien[1]!.content as Array<Record<string, any>>
    expect(alienParts).toHaveLength(1)
    expect(alienParts[0]!.type).toBe('text')
  })

  it('the model sees an event part as the text [event name] data', async () => {
    const history: StoredMessage[] = [
      {
        role: 'user',
        content: [{ type: 'event', name: 'operation_done', data: { id: 'op_1' } }],
      },
    ]
    const converted = await toModelMessages(history, { provider: 'anthropic', resolveImage: noImages })
    const parts = converted[0]!.content as Array<Record<string, any>>
    expect(parts[0]!.text).toBe('[event operation_done] {"id":"op_1"}')
  })

  it('an image goes as bytes, not as a URL', async () => {
    const png = 'data:image/png;base64,aGVsbG8='
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'image', url: png }] },
    ]
    const converted = await toModelMessages(history, {
      provider: 'anthropic',
      resolveImage: async (url) => parseDataUrl(url, 1_000_000),
    })
    const parts = converted[0]!.content as Array<Record<string, any>>
    expect(parts[0]!.type).toBe('image')
    expect(Buffer.from(parts[0]!.image as Uint8Array).toString('utf8')).toBe('hello')
    expect(parts[0]!.mediaType).toBe('image/png')
  })
})

describe('tool pair invariant (SPEC §5)', () => {
  it('tool_call without a result → unresolved_tool_call', () => {
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', call_id: 'c1', tool: 'x', args: {} }],
      },
    ]
    expect(() => assertToolInvariant(history)).toThrowError(EngineError)
    try {
      assertToolInvariant(history)
    } catch (err) {
      expect((err as EngineError).code).toBe('unresolved_tool_call')
      expect((err as EngineError).details.call_ids).toEqual(['c1'])
    }
  })
})

describe('last message of the history (SPEC §5)', () => {
  const user: StoredMessage = { role: 'user', content: [{ type: 'text', text: 'question' }] }
  const answer: StoredMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }

  it('ends with assistant → history_ends_with_assistant', () => {
    expect(() => assertLastMessage([user, answer])).toThrowError(EngineError)
    try {
      assertLastMessage([user, answer])
    } catch (err) {
      expect((err as EngineError).code).toBe('history_ends_with_assistant')
      expect((err as EngineError).status).toBe(400)
    }
  })

  it('a partial answer at the end is refused too', () => {
    expect(() => assertLastMessage([user, { ...answer, partial: true }])).toThrowError(EngineError)
  })

  it('ends with user or tool — ok', () => {
    expect(() => assertLastMessage([user])).not.toThrow()
    expect(() => assertLastMessage([user, answer, user])).not.toThrow()
    expect(() =>
      assertLastMessage([
        user,
        { role: 'assistant', content: [{ type: 'tool_call', call_id: 'c1', tool: 'x', args: {} }] },
        { role: 'tool', call_id: 'c1', tool: 'x', result: { ok: true }, is_error: false },
      ]),
    ).not.toThrow()
  })
})

describe('context trimming (SPEC §5.1)', () => {
  const text = (t: string): StoredMessage => ({ role: 'user', content: [{ type: 'text', text: t }] })

  it('drops the oldest, keeping the first user message and the last 4', () => {
    // Latin text is estimated at 4 chars per token: 400 chars keep the history well over the window
    const messages: StoredMessage[] = [
      text('first message ' + 'a'.repeat(400)),
      text('second ' + 'b'.repeat(400)),
      text('third ' + 'c'.repeat(400)),
      text('fourth ' + 'd'.repeat(400)),
      text('fifth ' + 'e'.repeat(400)),
      text('sixth ' + 'f'.repeat(400)),
    ]
    const result = trimHistory({
      messages,
      systemTokens: 10,
      toolTokens: 0,
      reserveTokens: 100,
      contextWindow: 600,
    })
    expect(result.trimmed).toBe(true)
    expect(result.messages[0]).toBe(messages[0])
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4))
    expect(result.messages.length).toBeLessThan(messages.length)
  })

  it('a tool_call + tool pair is dropped as a whole', () => {
    const messages: StoredMessage[] = [
      text('first'),
      {
        role: 'assistant',
        content: [{ type: 'tool_call', call_id: 'c1', tool: 'big', args: { q: 'x'.repeat(2000) } }],
      },
      { role: 'tool', call_id: 'c1', tool: 'big', result: { data: 'y'.repeat(2000) }, is_error: false },
      text('tail 1'),
      text('tail 2'),
      text('tail 3'),
      text('tail 4'),
    ]
    const result = trimHistory({
      messages,
      systemTokens: 0,
      toolTokens: 0,
      reserveTokens: 0,
      contextWindow: 200,
    })
    expect(result.trimmed).toBe(true)
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(false)
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  it('a history that fits is left untouched', () => {
    const messages = [text('short')]
    const result = trimHistory({
      messages,
      systemTokens: 1,
      toolTokens: 1,
      reserveTokens: 1,
      contextWindow: 100_000,
    })
    expect(result.trimmed).toBe(false)
    expect(result.messages).toEqual(messages)
  })
})

describe('system block with the date (SPEC §9.4)', () => {
  it('has the date, the time and the time zone', () => {
    const line = engineDateLine('Europe/Berlin', new Date('2026-09-03T09:00:00Z'))
    expect(line).toMatch(/^\[engine\] Current date and time: 2026-09-03T11:00:00\+02:00 \(Europe\/Berlin\)\.$/)
  })

  it('without cache_control — one system message (GigaChat: 422 on a second system message)', () => {
    const out = buildSystemMessages('Prompt', '[engine] date', false)
    expect(out).toEqual([{ role: 'system', content: 'Prompt\n\n[engine] date' }])
    expect(buildSystemMessages(null, '[engine] date', false)).toEqual([
      { role: 'system', content: '[engine] date' },
    ])
  })

  it('with cache_control — two blocks: the prompt is cached, the date is not', () => {
    const out = buildSystemMessages('Prompt', '[engine] date', true)
    expect(out).toHaveLength(2)
    expect(out[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(out[1]).toEqual({ role: 'system', content: '[engine] date' })
  })

  it('the date went into a user message — system holds only the prompt', () => {
    expect(buildSystemMessages('Prompt', null, false)).toEqual([{ role: 'system', content: 'Prompt' }])
    expect(buildSystemMessages(null, null, false)).toEqual([])
    const cached = buildSystemMessages('Prompt', null, true)
    expect(cached).toHaveLength(1)
    expect(cached[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })
})

describe('date and cache in messages (SPEC §9.3, §9.4)', () => {
  const CC = { anthropic: { cacheControl: { type: 'ephemeral' } } }
  const DATE = '[engine] Current date and time: 2026-10-12T15:00:00+02:00 (Europe/Berlin).'
  const first: StoredMessage = { role: 'user', content: [{ type: 'text', text: 'first' }] }
  const answer: StoredMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
  const last: StoredMessage = { role: 'user', content: [{ type: 'text', text: 'second' }] }

  it('without cache_control: the date is appended to the anchor text, other messages untouched', async () => {
    const out = await toModelMessages([first, answer, last], {
      provider: 'gigachat',
      resolveImage: noImages,
      dates: { timezone: 'Europe/Berlin', anchor: last, now: DATE },
    })
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'first' }] })
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: `second\n\n${DATE}` }] })
    // the StoredMessage from the request is not mutated — the client history has no date
    expect(last.content).toEqual([{ type: 'text', text: 'second' }])
  })

  it('without cache_control: the anchor ends with an image — the date is a separate part', async () => {
    const withImage: StoredMessage = {
      role: 'user',
      content: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }],
    }
    const out = await toModelMessages([withImage], {
      provider: 'glm',
      resolveImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      dates: { timezone: 'Europe/Berlin', anchor: withImage, now: DATE },
    })
    const content = out[0]!.content as Array<{ type: string; text?: string }>
    expect(content.map((p) => p.type)).toEqual(['image', 'text'])
    expect(content[1]!.text).toBe(DATE)
  })

  it('with cache_control: the date is a separate block, the cache point is on the block before it', async () => {
    const out = await toModelMessages([first, answer, last], {
      provider: 'anthropic',
      resolveImage: noImages,
      dates: { timezone: 'Europe/Berlin', anchor: last, now: DATE },
      cacheBreakpoints: true,
    })
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'second', providerOptions: CC },
        { type: 'text', text: DATE },
      ],
    })
    // the anchor is the prompt tail: no second point is placed
    const marked = out.flatMap((m) => m.content as Array<{ providerOptions?: unknown }>).filter((p) => p.providerOptions)
    expect(marked).toHaveLength(1)
  })

  it('with cache_control: a step with tools — the second point is on the last tool result', async () => {
    const call: StoredMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_call', call_id: 'c1', tool: 'getStatus', args: { id: '1' } },
        { type: 'tool_call', call_id: 'c2', tool: 'getStatus', args: { id: '2' } },
      ],
    }
    const r1: StoredMessage = { role: 'tool', call_id: 'c1', tool: 'getStatus', is_error: false, result: { ok: 1 } }
    const r2: StoredMessage = { role: 'tool', call_id: 'c2', tool: 'getStatus', is_error: false, result: { ok: 2 } }
    const out = await toModelMessages([last, call, r1, r2], {
      provider: 'anthropic',
      resolveImage: noImages,
      dates: { timezone: 'Europe/Berlin', anchor: last, now: DATE },
      cacheBreakpoints: true,
    })
    const results = out.at(-1)!.content as Array<{ providerOptions?: unknown }>
    expect(results).toHaveLength(2)
    expect(results[0]!.providerOptions).toBeUndefined()
    expect(results[1]!.providerOptions).toEqual(CC)
    expect((out[0]!.content as Array<{ providerOptions?: unknown }>)[0]!.providerOptions).toEqual(CC)
  })

  it('with cache_control and no date in messages — one point on the tail', async () => {
    const out = await toModelMessages([first, answer, last], {
      provider: 'anthropic',
      resolveImage: noImages,
      cacheBreakpoints: true,
    })
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'second', providerOptions: CC }] })
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'first' }] })
  })
})

describe('date from the created_at of a user message (SPEC §9.4)', () => {
  const CC = { anthropic: { cacheControl: { type: 'ephemeral' } } }
  const TZ = 'Europe/Berlin'
  const NOW = '[engine] Current date and time: 2026-10-12T17:00:00+02:00 (Europe/Berlin).'
  const user = (text: string, created_at?: string): StoredMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
    ...(created_at ? { created_at } : {}),
  })
  const reply = (text: string): StoredMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })

  it('the line comes from created_at in the time zone; an invalid created_at gives null', () => {
    expect(messageDateLine('2026-10-12T12:03:21.500Z', TZ)).toBe(
      '[engine] Message date and time: 2026-10-12T14:03:21+02:00 (Europe/Berlin).',
    )
    expect(messageDateLine('yesterday', TZ)).toBeNull()
  })

  it('the ru catalog passed explicitly still gives the Russian date lines', () => {
    const ru = texts('ru')
    expect(messageDateLine('2026-10-12T12:03:21.500Z', TZ, ru)).toBe(
      '[engine] Дата и время сообщения: 2026-10-12T14:03:21+02:00 (Europe/Berlin).',
    )
    expect(engineDateLine(TZ, new Date('2026-09-03T09:00:00Z'), ru)).toBe(
      '[engine] Текущая дата и время: 2026-09-03T11:00:00+02:00 (Europe/Berlin).',
    )
  })

  it('every user message with created_at gets its own date, no current time', async () => {
    const u1 = user('first', '2026-10-12T12:00:00Z')
    const u2 = user('second', '2026-10-12T12:05:00Z')
    const out = await toModelMessages([u1, reply('answer'), u2], {
      provider: 'gigachat',
      resolveImage: noImages,
      dates: { timezone: TZ, anchor: u2, now: NOW },
    })
    const lines = out.filter((m) => m.role === 'user').map((m) => (m.content as Array<{ text: string }>)[0]!.text)
    expect(lines).toEqual([
      'first\n\n[engine] Message date and time: 2026-10-12T14:00:00+02:00 (Europe/Berlin).',
      'second\n\n[engine] Message date and time: 2026-10-12T14:05:00+02:00 (Europe/Berlin).',
    ])
    expect(JSON.stringify(out)).not.toContain('Current date')
  })

  it('the history is only appended to: the prompt of turn N is a prefix of the prompt of turn N+1', async () => {
    const u1 = user('first', '2026-10-12T12:00:00Z')
    const a1 = reply('answer')
    const u2 = user('second', '2026-10-12T12:05:00Z')
    const turnN = await toModelMessages([u1, a1, u2], {
      provider: 'glm',
      resolveImage: noImages,
      dates: { timezone: TZ, anchor: u2, now: NOW },
    })
    const u3 = user('third', '2026-10-12T12:09:00Z')
    const turnNext = await toModelMessages([u1, a1, u2, reply('another answer'), u3], {
      provider: 'glm',
      resolveImage: noImages,
      dates: { timezone: TZ, anchor: u3, now: NOW.replace('17:00:00', '17:09:00') },
    })
    expect(turnNext.slice(0, turnN.length)).toEqual(turnN)
  })

  it('with cache_control: the date is a separate part with no point before it, the tail point is on the date', async () => {
    const u1 = user('first', '2026-10-12T12:00:00Z')
    const out = await toModelMessages([u1], {
      provider: 'anthropic',
      resolveImage: noImages,
      dates: { timezone: TZ, anchor: u1, now: NOW },
      cacheBreakpoints: true,
    })
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        {
          type: 'text',
          text: '[engine] Message date and time: 2026-10-12T14:00:00+02:00 (Europe/Berlin).',
          providerOptions: CC,
        },
      ],
    })
  })

  it('an anchor without created_at (or with an invalid one) gets the current time, older user messages keep their dates', async () => {
    const u1 = user('first', '2026-10-12T12:00:00Z')
    const u2 = user('second', 'not a date')
    const out = await toModelMessages([u1, reply('answer'), u2], {
      provider: 'anthropic',
      resolveImage: noImages,
      dates: { timezone: TZ, anchor: u2, now: NOW },
      cacheBreakpoints: true,
    })
    const firstParts = out[0]!.content as Array<{ text: string; providerOptions?: unknown }>
    expect(firstParts.map((p) => p.text)).toEqual([
      'first',
      '[engine] Message date and time: 2026-10-12T14:00:00+02:00 (Europe/Berlin).',
    ])
    expect(firstParts.every((p) => p.providerOptions === undefined)).toBe(true)
    // the current time comes with a cache point before it
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'second', providerOptions: CC },
        { type: 'text', text: NOW },
      ],
    })
  })
})
