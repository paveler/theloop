/**
 * Thinking blocks bound to the prefix (SPEC §9.3) and Claude context windows (SPEC §5.1):
 * an engine-made edit of a signed prefix — trimming, a current-time line that moved — sends
 * `block_binding: drop_block` on the models that run the check, and only then.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult, StoredMessage } from '../src/contracts.js'
import type { LogEntry } from '../src/log-buffer.js'
import { contextWindowFor } from '../src/providers/allowlist.js'
import { bindsThinkingToPrefix, type ResolvedModel } from '../src/providers/factory.js'
import { editsSignedPrefix } from '../src/runs/messages.js'
import { bearer, finish, mockFactory, mockModel, runRequest, START, streamFrom, textChunks, testConfig } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

const DROP_BLOCK = { blockBinding: { prefixMismatchBehavior: 'drop_block' } }
const AT = '2026-10-27T09:00:00.000Z'

function reasoning(provider = 'anthropic') {
  return { type: 'reasoning' as const, text: '', provider, provider_metadata: { anthropic: { signature: 'sig' } } }
}

/**
 * A droppable filler turn, then a turn with signed thinking inside the protected tail (the
 * last 4 messages, SPEC §5.1). Earlier user messages are dated unless told otherwise.
 */
function history(options: { dated?: boolean; filler?: string; provider?: string } = {}): StoredMessage[] {
  const at = options.dated === false ? {} : { created_at: AT }
  return [
    { role: 'user', content: [{ type: 'text', text: 'start' }], ...at },
    { role: 'assistant', content: [{ type: 'text', text: options.filler ?? 'filler' }] },
    { role: 'user', content: [{ type: 'text', text: 'more' }], ...at },
    { role: 'assistant', content: [reasoning(options.provider), { type: 'text', text: 'answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'and?' }], ...at },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }], created_at: AT },
  ] as StoredMessage[]
}

async function run(
  messages: StoredMessage[],
  overrides: Partial<ResolvedModel> = {},
  finishPart = finish('stop'),
): Promise<{ result: RunResult; options: any; journal: LogEntry[] }> {
  const model = mockModel([streamFrom([START, ...textChunks('ok'), finishPart])])
  const engine = createEngine(testConfig(), {
    modelFactory: mockFactory(model, { thinkingPrefixBinding: true, ...overrides }),
  })
  cleanup.push(() => engine.shutdown())
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify(runRequest({ messages: messages as never, limits: { max_tokens: 1000 }, wait: true })),
  })
  expect(res.status).toBe(200)
  const result = (await res.json()) as RunResult
  const logs = await engine.app.request(`/runs/${result.run_id}/logs`, { headers: bearer() })
  return {
    result,
    options: model.doStreamCalls[0]!.providerOptions,
    journal: ((await logs.json()) as { entries: LogEntry[] }).entries,
  }
}

describe('Claude context windows (SPEC §5.1)', () => {
  it.each([
    ['claude-fable-5-1', 1_000_000],
    ['claude-opus-5-5', 1_000_000],
    ['claude-sonnet-5-5', 1_000_000],
    ['claude-haiku-5-5', 1_000_000],
    ['claude-sonnet-5', 1_000_000],
    ['claude-opus-4-6', 1_000_000],
    ['claude-sonnet-4-6', 1_000_000],
    ['claude-haiku-4-5', 200_000],
    ['claude-haiku-4-5-20251001', 200_000],
    ['claude-sonnet-4-5', 200_000],
    ['claude-opus-4-5-20251101', 200_000],
    ['claude-opus-4-1', 200_000],
    ['claude-sonnet-4-20250514', 200_000],
    ['claude-opus-4-0', 200_000],
    ['claude-3-7-sonnet-20250219', 200_000],
  ])('window of %s is %i', (model, size) => {
    expect(contextWindowFor(model, 128_000)).toBe(size)
  })
})

describe('models that bind thinking to the prefix (SPEC §9.3)', () => {
  it.each([
    ['claude-fable-5-1', true],
    ['claude-opus-5-5', true],
    ['claude-sonnet-5-5', true],
    ['claude-haiku-5-5', true],
    ['claude-opus-6', true],
    ['claude-fable-5', false],
    ['claude-mythos-5-1', false],
    ['claude-opus-5', false],
    ['claude-sonnet-5', false],
    ['claude-opus-4-8', false],
    ['claude-haiku-4-5', false],
  ])('%s: %s', (model, binds) => {
    expect(bindsThinkingToPrefix('anthropic', model)).toBe(binds)
  })

  it('only on anthropic: MiniMax uses the Anthropic adapter but has no such check', () => {
    expect(bindsThinkingToPrefix('minimax', 'claude-opus-5-5')).toBe(false)
  })
})

describe('editsSignedPrefix (SPEC §9.3)', () => {
  const anchorOf = (messages: StoredMessage[]) => messages.at(-1)!

  it('trimmed with this provider reasoning — yes; reasoning of another provider — no', () => {
    const dated = history()
    expect(editsSignedPrefix(dated, { provider: 'anthropic', trimmed: true, anchor: anchorOf(dated) })).toBe(true)
    const minimax = history({ provider: 'minimax' })
    expect(editsSignedPrefix(minimax, { provider: 'anthropic', trimmed: true, anchor: anchorOf(minimax) })).toBe(false)
  })

  it('not trimmed, every user message dated — no', () => {
    const dated = history()
    expect(editsSignedPrefix(dated, { provider: 'anthropic', trimmed: false, anchor: anchorOf(dated) })).toBe(false)
  })

  it('an earlier user message without created_at lost its current-time line — yes', () => {
    const undated = history({ dated: false })
    expect(editsSignedPrefix(undated, { provider: 'anthropic', trimmed: false, anchor: anchorOf(undated) })).toBe(true)
  })

  it('an undated message after the last signed block does not count', () => {
    const messages = [...history(), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] as StoredMessage[]
    messages.push({ role: 'user', content: [{ type: 'text', text: 'undated, not the anchor' }] } as StoredMessage)
    messages.push({ role: 'user', content: [{ type: 'text', text: 'anchor' }] } as StoredMessage)
    expect(editsSignedPrefix(messages, { provider: 'anthropic', trimmed: false, anchor: anchorOf(messages) })).toBe(false)
  })
})

describe('drop_block on engine-made edits (SPEC §9.3)', () => {
  it('trimming: thinking keeps the model default (adaptive) and gets drop_block', async () => {
    const { result, options } = await run(history({ filler: 'x'.repeat(20_000) }), { contextWindow: 4_000 })
    expect(result.context_trimmed).toBe(true)
    expect(options.anthropic.thinking).toEqual({ type: 'adaptive', ...DROP_BLOCK })
  })

  it('a moved current-time line, no trimming: drop_block', async () => {
    const { result, options } = await run(history({ dated: false }))
    expect(result.context_trimmed).toBe(false)
    expect(options.anthropic.thinking).toEqual({ type: 'adaptive', ...DROP_BLOCK })
  })

  it('effort and thinking from params stay as they are', async () => {
    const { options } = await run(history({ dated: false }), {
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
    })
    expect(options.anthropic).toEqual({ thinking: { type: 'adaptive', ...DROP_BLOCK }, effort: 'medium' })
  })

  it('an append-only history: nothing is added', async () => {
    const { options } = await run(history())
    expect(options?.anthropic?.thinking).toBeUndefined()
  })

  it('a model without the check: nothing is added even when trimmed', async () => {
    const { result, options } = await run(history({ filler: 'x'.repeat(20_000) }), {
      contextWindow: 4_000,
      thinkingPrefixBinding: false,
    })
    expect(result.context_trimmed).toBe(true)
    expect(options?.anthropic?.thinking).toBeUndefined()
  })

  it('what the provider dropped goes to the journal', async () => {
    const dropped = {
      ...finish('stop'),
      providerMetadata: {
        anthropic: {
          inputTransformations: [
            { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
            { type: 'thinking_mismatch_allowed', path: 'messages.5.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      },
    }
    const { journal } = await run(history({ dated: false }), {}, dropped as never)
    const entry = journal.find((e) => e.event === 'thinking_blocks_dropped')
    expect(entry).toMatchObject({ step: 1, dropped: 1, reasons: ['prefix_binding_mismatch'] })
  })
})
