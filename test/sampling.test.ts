/**
 * Sampling on new Claude models (SPEC §9.3): temperature / top_p are not sent to a model
 * that answers them with 400; the run does not fail, the journal gets a warn
 * `llm_param_unsupported`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { log } from '../src/log.js'
import { buildModel, isNewClaude, type ModelFactory } from '../src/providers/factory.js'
import { bearer, finish, mockModel, runRequest, START, streamFrom, textChunks, testConfig } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe('isNewClaude: which ids reject sampling and a thinking budget', () => {
  it.each([
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-haiku-5-5',
    'CLAUDE-SONNET-5-5',
  ])('%s: yes', (model) => {
    expect(isNewClaude(model)).toBe(true)
  })

  it.each([
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-1-20250805',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-haiku-20241022',
    'minimax-m3',
  ])('%s: no', (model) => {
    expect(isNewClaude(model)).toBe(false)
  })
})

describe('sampling to streamText: not sent for new Claude models, the run proceeds (SPEC §9.3)', () => {
  /** The real factory (flags, warn), but a mock model instead of Anthropic. */
  async function run(provider: string, model: string, params: Record<string, unknown>) {
    const mock = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const factory: ModelFactory = (llm, config, egress) => ({ ...buildModel(llm, config, egress), model: mock as never })
    const engine: Engine = createEngine(testConfig(), { modelFactory: factory })
    cleanup.push(() => engine.shutdown())

    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest({ llm: { provider, model, api_key: 'sk-test', params } as never })),
    })
    expect(res.status).toBe(200)
    const result = (await res.json()) as RunResult
    return { result, call: mock.doStreamCalls[0]! }
  }

  it('claude-sonnet-5-5 with temperature and top_p: both dropped, a warn for each', async () => {
    const warn = vi.spyOn(log, 'warn')
    const { result, call } = await run('anthropic', 'claude-sonnet-5-5', { temperature: 0.3, top_p: 0.9 })

    expect(result.status).toBe('completed')
    expect(call.temperature).toBeUndefined()
    expect(call.topP).toBeUndefined()
    for (const param of ['temperature', 'top_p']) {
      expect(warn).toHaveBeenCalledWith('llm_param_unsupported', {
        param,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
      })
    }
  })

  it.each(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])('%s: temperature is not sent', async (model) => {
    const { result, call } = await run('anthropic', model, { temperature: 0.3 })
    expect(result.status).toBe('completed')
    expect(call.temperature).toBeUndefined()
  })

  it('no sampling in params: no warn', async () => {
    const warn = vi.spyOn(log, 'warn')
    await run('anthropic', 'claude-sonnet-5-5', {})
    expect(warn).not.toHaveBeenCalledWith('llm_param_unsupported', expect.anything())
  })

  it('claude-sonnet-4-6 accepts sampling: sent as is, no warn', async () => {
    const warn = vi.spyOn(log, 'warn')
    const { result, call } = await run('anthropic', 'claude-sonnet-4-6', { temperature: 0.3, top_p: 0.9 })

    expect(result.status).toBe('completed')
    expect(call.temperature).toBe(0.3)
    expect(call.topP).toBe(0.9)
    expect(warn).not.toHaveBeenCalledWith('llm_param_unsupported', expect.anything())
  })

  it('not anthropic: the Claude list does not apply', async () => {
    const { call } = await run('minimax', 'claude-sonnet-5-5', { temperature: 0.3 })
    expect(call.temperature).toBe(0.3)
  })
})
