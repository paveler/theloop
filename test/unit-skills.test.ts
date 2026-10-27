import { describe, expect, it } from 'vitest'
import { RunRequestSchema, SKILL_LIMITS } from '../src/contracts.js'
import { texts } from '../src/i18n.js'
import { supportsToolReferences } from '../src/providers/factory.js'
import { SkillState } from '../src/runs/skills.js'
import { runRequest } from './helpers.js'

describe('tool_reference capability (SPEC §9.2)', () => {
  it.each([
    ['claude-sonnet-4-5', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-opus-4-6', true],
    ['claude-sonnet-5-5', true],
    ['claude-fable-5-1', true],
    ['claude-mythos-preview', true],
    ['claude-opus-4-1', false],
    ['claude-sonnet-4-20250514', false],
    ['claude-3-5-haiku-latest', false],
  ])('%s → %s', (model, expected) => {
    expect(supportsToolReferences('anthropic', model)).toBe(expected)
  })

  it('MiniMax uses the Anthropic adapter but has no defer_loading', () => {
    expect(supportsToolReferences('minimax', 'claude-sonnet-5-5')).toBe(false)
  })
})

describe('skill index (SPEC §6.8)', () => {
  const request = {
    tools: [],
    skills: [
      { name: 'shipping', description: 'Тарифы доставки.', body: 'x', tools: [] },
      { name: 'order-returns', description: 'Возвраты.', body: 'x', tools: [] },
    ],
  }

  it('ru: localized header, lines sorted by name', () => {
    expect(new SkillState(request, false, texts('ru')).index()).toBe(
      '[engine] Скиллы. Прежде чем браться за тему, которую покрывает скилл, вызови load_skill с его ' +
        'именем: инструкции и тулы скилла придут на следующем шаге.\n' +
        '- order-returns: Возвраты.\n' +
        '- shipping: Тарифы доставки.',
    )
  })

  it('no skills, no index and no built-ins', () => {
    const state = new SkillState({ tools: [], skills: [] }, true, texts())
    expect(state.index()).toBeNull()
    expect(state.builtins).toEqual([])
    expect(state.enabled).toBe(false)
    expect(state.mechanism).toBe('tools_array')
  })
})

describe('skills[] schema (SPEC §4.2)', () => {
  const parse = (body: string) =>
    RunRequestSchema.safeParse(runRequest({ skills: [{ name: 'a', description: 'a', body }] as never }))

  it('the body limit is in UTF-8 bytes, not characters', () => {
    expect(parse('я'.repeat(SKILL_LIMITS.body_max_bytes / 2)).success).toBe(true)
    expect(parse('я'.repeat(SKILL_LIMITS.body_max_bytes / 2 + 1)).success).toBe(false)
  })

  it('an empty body is refused', () => {
    expect(parse('').success).toBe(false)
  })
})
