/**
 * Format gate for blocks in the final answer (SPEC §5.4): finding the block, schema
 * validation, errors for the model, repair steps in the loop, the final message, SSE,
 * the result, the journal. Fixtures — a synthetic rule-card schema (inbox rules for a
 * help desk) and a corpus of model-like blocks with typical breakage.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import type { RunResult } from '../src/contracts.js'
import { EngineError } from '../src/errors.js'
import { texts } from '../src/i18n.js'
import {
  appendBlock,
  checkText,
  compileOutputChecks,
  findBlocks,
  issueLines,
  repairPrompt,
  stripBlocks,
  type CompiledOutputCheck,
} from '../src/runs/output-checks.js'
import {
  bearer,
  finish,
  hangingStream,
  json,
  mockFactory,
  mockModel,
  parseSse,
  readSseUntil,
  runRequest,
  START,
  startServer,
  streamFrom,
  textChunks,
  testConfig,
  toolCall,
  waitFor,
  type LocalServer,
} from './helpers.js'

const SCHEMA = JSON.parse(readFileSync(new URL('./fixtures/rule-card.schema.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>
const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/rule-card-corpus.json', import.meta.url), 'utf8')) as Array<{
  name: string
  block: string
  valid: boolean | null
}>

const FENCE = 'rule-card'

/** The model merged two conditions into one rule — the most common breakage of this block. */
const BAD_BLOCK = JSON.stringify({
  summary: 'Escalate tickets from enterprise customers and tickets about outages.',
  rules: [
    {
      match: 'all',
      predicates: [
        { op: 'from_domain_in', domains: ['enterprise.example.com'] },
        { op: 'subject_has', terms: ['outage', 'service down'] },
      ],
      action: 'escalate',
      weight: 3,
    },
  ],
})

/** The same after repair: two rules, one condition each in `condition`. */
const FIXED_BLOCK = JSON.stringify({
  summary: 'Escalate tickets from enterprise customers and tickets about outages.',
  rules: [
    { condition: { op: 'from_domain_in', domains: ['enterprise.example.com'] }, action: 'escalate', weight: 3 },
    { condition: { op: 'subject_has', terms: ['outage', 'service down'] }, action: 'escalate', weight: 3 },
  ],
})

const GOOD_BLOCK = JSON.stringify({
  summary: 'Archive newsletters.',
  rules: [{ condition: { op: 'subject_has', terms: ['weekly newsletter'] }, action: 'archive', weight: 6 }],
})

const INTRO = 'Got it: tickets from enterprise customers and outage reports should go up the queue. Here is the rule I suggest.'

function fenced(raw: string, fence = FENCE): string {
  return '```' + fence + '\n' + raw + '\n```'
}

function rulesCheck(maxRepairs?: number): CompiledOutputCheck {
  return compileOutputChecks([{ fence: FENCE, schema: SCHEMA, ...(maxRepairs != null ? { max_repairs: maxRepairs } : {}) }])[0]!
}

/* ------------------------------------------------------------- module */

describe('output_checks: the block in the text', () => {
  it('the last closed block is taken; earlier ones are cut together with it', () => {
    const text = `one\n\n${fenced('{"a":1}')}\n\ntwo\n\n${fenced('{"a":2}')}\n\nthree`
    const blocks = findBlocks(text, FENCE)
    expect(blocks.map((b) => b.raw.trim())).toEqual(['{"a":1}', '{"a":2}'])
    expect(blocks.every((b) => b.closed)).toBe(true)
    expect(stripBlocks(text, FENCE)).toBe('one\n\ntwo\n\nthree')
  })

  it('an inline "```rule-card```" in the text is not a block', () => {
    const text = 'The ```rule-card``` format is described in the docs.\n```rule-card```\nand that is all'
    expect(findBlocks(text, FENCE)).toEqual([])
    expect(checkText(text, rulesCheck()).kind).toBe('absent')
  })

  it('fence: an info string and indentation are allowed, another label with the same prefix is not', () => {
    expect(findBlocks('  ```rule-card json\n{}\n  ```  ', FENCE)).toHaveLength(1)
    expect(findBlocks('```rule-card-v2\n{}\n```', FENCE)).toHaveLength(0)
    expect(findBlocks('```rule\n{}\n```', 'rule')).toHaveLength(1)
    expect(findBlocks('```rule-card\n{}\n```', 'rule')).toHaveLength(0)
  })

  it('closing is a line of ``` and whitespace; an unclosed last block is a failure', () => {
    const check = rulesCheck()
    const unclosed = checkText(`text\n\`\`\`rule-card\n${GOOD_BLOCK}\n`, check)
    expect(unclosed.kind).toBe('invalid')
    expect(unclosed.kind === 'invalid' && unclosed.issues[0]!.path).toBe('block_unclosed')
    // "```json" after the block is not a closing line
    expect(findBlocks('```rule-card\n{}\n```json\n```', FENCE)[0]!.raw).toBe('{}\n```json\n')
  })

  it('the GigaChat <|superquote|> is a quote', () => {
    const raw = GOOD_BLOCK.replaceAll('"', '<|superquote|>')
    const verdict = checkText(fenced(raw), rulesCheck())
    expect(verdict.kind).toBe('valid')
    expect(verdict.kind === 'valid' && verdict.raw.trim()).toBe(GOOD_BLOCK)
  })

  it('invalid JSON is one error line without newlines', () => {
    const verdict = checkText(fenced('{"rules": [\n}'), rulesCheck())
    expect(verdict.kind).toBe('invalid')
    const lines = verdict.kind === 'invalid' ? issueLines(verdict.issues) : []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^JSON did not parse: /)
    expect(lines[0]).not.toContain('\n')
  })

  it('append puts the block at the end after a blank line', () => {
    expect(appendBlock('text', FENCE, '{}\n')).toBe('text\n\n```rule-card\n{}\n```')
    expect(appendBlock('', FENCE, '{}')).toBe('```rule-card\n{}\n```')
  })
})

describe('output_checks: schema verdicts on a corpus', () => {
  it(`schema verdicts match the expected verdicts on all ${CORPUS.length} blocks`, () => {
    const check = rulesCheck()
    const mismatched = CORPUS.filter((item) => {
      const verdict = checkText(`answer\n\n${fenced(item.block)}`, check)
      // null in the corpus is an empty block: valid, but the client renders no card
      return (verdict.kind === 'valid') !== (item.valid !== false)
    })
    expect(mismatched.map((m) => m.name)).toEqual([])
    expect(CORPUS.length).toBeGreaterThanOrEqual(41)
  })
})

describe('output_checks: errors for the model', () => {
  const issuesOf = (raw: string) => {
    const verdict = checkText(fenced(raw), rulesCheck())
    if (verdict.kind !== 'invalid') throw new Error(`expected invalid, got ${verdict.kind}`)
    return issueLines(verdict.issues)
  }

  it('key ".predicate": names the condition field and the mangled key, without the errors of every oneOf branch', () => {
    const lines = issuesOf(
      '{"rules":[{".predicate":{"op":"subject_has","terms":["refund"]},"action":"label","label":"billing","weight":6}]}',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\/rules\/0: must have field "condition"; key "\.predicate" is not recognized/)
    expect(lines[0]).toContain('exactly one condition')
  })

  it('condition and predicate at once — "only one of fields"', () => {
    const lines = issuesOf(
      '{"rules":[{"condition":{"op":"subject_has","terms":["a"]},"predicate":{"op":"subject_has","terms":["a"]},"action":"escalate","weight":1}]}',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('only one of fields "condition", "predicate", "predicates" is allowed')
    expect(lines[0]).toContain('but "condition" and "predicate" are set')
  })

  it('two conditions in a rule: maxItems with the schema hint; an invented op — with the list of allowed ones', () => {
    const lines = issuesOf(
      '{"rules":[{"match":"all","predicates":[{"op":"subject_has","terms":["outage"]},{"op":"negate","value":true}],"action":"archive","weight":3}]}',
    )
    expect(lines[0]).toMatch(/^\/rules\/0\/predicates\/1\/op: .*"subject_has", "body_has"/)
    expect(lines[1]).toMatch(/^\/rules\/0\/predicates: must NOT have more than 1 items\. A new rule has exactly one condition/)
    // the discriminator duplicates the enum — not shown
    expect(lines.some((l) => l.includes('oneOf'))).toBe(false)
    expect(lines).toHaveLength(2)
  })

  it('anyOf by type: a branch of another type is dropped; both bounds null — the concrete one is named', () => {
    expect(
      issuesOf('{"rules":[{"condition":{"op":"subject_has","terms":["a"]},"action":"escalate","weight":0}]}'),
    ).toEqual(['/rules/0/weight: must be > 0'])
    // the bound is anyOf number / numeric string / null: only the number branch is about -5
    expect(
      issuesOf('{"rules":[{"condition":{"op":"size_range","min":-5},"action":"archive","weight":1}]}'),
    ).toEqual(['/rules/0/condition/min: must be >= 0'])
    expect(
      issuesOf('{"rules":[{"condition":{"op":"size_range","min":null,"max":null},"action":"archive","weight":1}]}'),
    ).toEqual(['/rules/0/condition/min: cannot be null'])
  })

  it('an object instead of a list', () => {
    expect(issuesOf('{"routing":{"type":"team_adjust","add":["billing"]}}')).toEqual(['/routing: must be array'])
  })

  it('at most 8 lines, deepest paths first', () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({
      condition: { op: 'subject_has', terms: ['a'] },
      action: 'escalate',
      weight: 20 + i,
    }))
    const block = { rules, routing: {}, remove_rules: {}, remove_routing: {}, summary: 5 }
    const lines = issuesOf(JSON.stringify(block))
    expect(lines).toHaveLength(8)
    expect(lines[7]).toMatch(/^…and \d+ more$/)
    expect(lines[0]).toMatch(/^\/rules\/\d\/weight/)
  })

  it('the synthetic message follows the contract', () => {
    const verdict = checkText(fenced(BAD_BLOCK), rulesCheck())
    const text = repairPrompt(FENCE, verdict.kind === 'invalid' ? verdict.issues : [])
    const lines = text.split('\n')
    expect(lines[0]).toBe('[Format check] The rule-card block failed validation:')
    expect(lines[1]).toMatch(/^- \/rules\/0\/predicates: /)
    expect(lines.at(-1)).toBe('Send only the corrected ```rule-card``` block, with no text before or after.')
  })

  it('ru locale: the repair message and the engine phrases are in Russian', () => {
    const ru = texts('ru')
    const verdict = checkText(fenced(BAD_BLOCK), rulesCheck(), ru)
    const text = repairPrompt(FENCE, verdict.kind === 'invalid' ? verdict.issues : [], ru)
    const lines = text.split('\n')
    expect(lines[0]).toBe('[Проверка формата] Блок rule-card не прошёл проверку:')
    // ajv-i18n message; the hint is the schema's own description, as is
    expect(lines[1]).toMatch(/^- \/rules\/0\/predicates: должно иметь не более, чем 1 элемент\. A new rule has exactly one condition/)
    expect(lines.at(-1)).toBe('Пришли только исправленный блок ```rule-card```, без текста до и после.')

    const lookalike = checkText(
      fenced('{"rules":[{".predicate":{"op":"subject_has","terms":["refund"]},"action":"label","weight":6}]}'),
      rulesCheck(),
      ru,
    )
    expect(lookalike.kind === 'invalid' && issueLines(lookalike.issues, ru)[0]).toMatch(
      /^\/rules\/0: должно быть поле "condition"; ключ "\.predicate" не распознан/,
    )
    const broken = checkText(fenced('{"rules": ['), rulesCheck(), ru)
    expect(broken.kind === 'invalid' && issueLines(broken.issues, ru)[0]).toMatch(/^JSON не разобрался: /)
  })
})

describe('output_checks: compilation', () => {
  it('max_repairs: default 1, ceiling 3', () => {
    expect(rulesCheck().maxRepairs).toBe(1)
    expect(rulesCheck(0).maxRepairs).toBe(0)
    expect(rulesCheck(10).maxRepairs).toBe(3)
  })

  it('broken schema / duplicate fence / over 64 KB — bad_request', () => {
    const expectBad = (fn: () => unknown, pattern: RegExp) => {
      try {
        fn()
        throw new Error('expected EngineError')
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError)
        expect((err as EngineError).code).toBe('bad_request')
        expect((err as EngineError).message).toMatch(pattern)
      }
    }
    expectBad(() => compileOutputChecks([{ fence: 'x', schema: { type: 'nonsense' } }]), /^output_check_schema_invalid: x: /)
    expectBad(() => compileOutputChecks([{ fence: 'x', schema: { $ref: '#/$defs/missing' } }]), /^output_check_schema_invalid: x: /)
    expectBad(
      () => compileOutputChecks([{ fence: 'x', schema: { type: 'object' } }, { fence: 'x', schema: { type: 'object' } }]),
      /^output_checks\[1\]\.fence: fence "x" is already in the list$/,
    )
    // 40 000 characters, but 80 000 bytes in UTF-8: the limit is in bytes
    expectBad(
      () => compileOutputChecks([{ fence: 'x', schema: { description: 'é'.repeat(40_000) } }]),
      /^output_check_schema_too_large: x: /,
    )
  })
})

/* ---------------------------------------------------------------- loop */

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function track(engine: Engine): Engine {
  cleanup.push(() => engine.shutdown())
  return engine
}

function trackServer(server: LocalServer): LocalServer {
  cleanup.push(() => server.close())
  return server
}

async function post(engine: Engine, body: Record<string, unknown>): Promise<Response> {
  return engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
}

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await post(engine, { ...body, wait: true })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

function checks(maxRepairs?: number) {
  return [{ fence: FENCE, schema: SCHEMA, ...(maxRepairs != null ? { max_repairs: maxRepairs } : {}) }]
}

/** A tool, so that the repair step has something for tool_choice to switch off. */
function readTool(url = 'http://127.0.0.1:1') {
  return {
    name: 'getInboxRules',
    description: 'current inbox rules',
    input_schema: { type: 'object', properties: {} },
    endpoint: `${url}/getInboxRules`,
    effect: 'read',
  }
}

function textAnswer(text: string, usage?: Parameters<typeof finish>[1]) {
  return streamFrom([START, ...textChunks(text), finish('stop', usage)])
}

function assistantText(result: RunResult): string {
  const assistants = result.messages.filter((m) => m.role === 'assistant')
  const last = assistants.at(-1) as { content: Array<{ type: string; text?: string }> } | undefined
  return last?.content.filter((p) => p.type === 'text').map((p) => p.text).join('') ?? ''
}

/** Text from a step's prompt: the last message of the given role. */
function promptText(model: ReturnType<typeof mockModel>, call: number, role: string, fromEnd = 1): string {
  const messages = model.doStreamCalls[call]!.prompt.filter((m) => m.role === role)
  const message = messages[messages.length - fromEnd]!
  return (message.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

describe('output_checks: loop', () => {
  it('valid block → passed, no extra steps, text untouched', async () => {
    const answer = `Done.\n\n${fenced(GOOD_BLOCK)}`
    const model = mockModel([textAnswer(answer)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ output_checks: checks() } as never))

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(assistantText(result)).toBe(answer)
    expect(result.output_checks).toEqual([{ fence: FENCE, status: 'passed', attempts: 0 }])
  })

  it('two conditions in a rule → repair: the original text without the broken block + the repaired block', async () => {
    const original = `${INTRO}\n\n${fenced(BAD_BLOCK)}\n\nTell me if anything is off.`
    const model = mockModel([
      textAnswer(original),
      textAnswer(`Here is the corrected block:\n${fenced(FIXED_BLOCK)}`),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool()] as never, output_checks: checks() } as never),
    )

    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    // one assistant message, no synthetic message and no draft
    expect(result.messages).toHaveLength(1)
    expect(assistantText(result)).toBe(`${INTRO}\n\nTell me if anything is off.\n\n${fenced(FIXED_BLOCK)}`)
    expect(JSON.stringify(result.messages)).not.toContain('[Format check]')
    expect(JSON.stringify(result.messages)).not.toContain('Here is the corrected block')

    expect(result.output_checks).toEqual([
      {
        fence: FENCE,
        status: 'repaired',
        attempts: 1,
        errors: [expect.stringMatching(/^\/rules\/0\/predicates: must NOT have more than 1 items/)],
      },
    ])
    // repair is outside max_steps, but in usage
    expect(result.timing.steps).toBe(1)
    expect(result.usage.calls).toHaveLength(2)

    // repair step: tool_choice none; the provider gets the answer as is and the synthetic message from user
    expect(model.doStreamCalls[0]!.toolChoice?.type).not.toBe('none')
    expect(model.doStreamCalls[1]!.toolChoice).toEqual({ type: 'none' })
    const repairPromptMessages = model.doStreamCalls[1]!.prompt
    expect(repairPromptMessages.at(-1)!.role).toBe('user')
    expect(promptText(model, 1, 'user')).toMatch(/^\[Format check\] The rule-card block failed validation:\n- \/rules\/0\/predicates: /)
    expect(promptText(model, 1, 'assistant')).toBe(original)
    expect(repairPromptMessages.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('the repair step is not part of result.context: its synthetic message does not enter the history', async () => {
    const original = `${INTRO}\n\n${fenced(BAD_BLOCK)}`
    const model = mockModel([
      textAnswer(original, { inputTokens: 1000, outputTokens: 80 }),
      textAnswer(fenced(FIXED_BLOCK), { inputTokens: 1200, outputTokens: 60 }),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ output_checks: checks() } as never))

    expect(result.output_checks?.[0]).toMatchObject({ status: 'repaired' })
    expect(result.usage.calls).toHaveLength(2)
    expect(result.context).toEqual({ used_tokens: 1080, window_tokens: 200_000, estimated: false })
  })

  it('repair failed max_repairs times → failed, block cut', async () => {
    const original = `${INTRO}\n\n${fenced(BAD_BLOCK)}`
    const model = mockModel([
      textAnswer(original),
      textAnswer(fenced(BAD_BLOCK)), // the same again
      textAnswer('Sorry, I cannot.'), // no block
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ output_checks: checks(2) } as never))

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(assistantText(result)).toBe(INTRO)
    expect(result.output_checks).toEqual([
      {
        fence: FENCE,
        status: 'failed',
        attempts: 2,
        errors: [expect.stringMatching(/^\/rules\/0\/predicates: /)],
        reason: 'repairs_exhausted',
      },
    ])
    // the second repair sees its previous draft and the new synthetic message
    expect(promptText(model, 2, 'assistant')).toBe(fenced(BAD_BLOCK))
    expect(promptText(model, 2, 'user')).toMatch(/^\[Format check\]/)
    expect(promptText(model, 2, 'assistant', 2)).toBe(original)
    expect(result.usage.calls).toHaveLength(3)
  })

  it('max_repairs 0 and an answer that is only the block: check without repair, the empty message is dropped', async () => {
    const model = mockModel([textAnswer(fenced(BAD_BLOCK))])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ output_checks: checks(0) } as never))

    expect(model.doStreamCalls).toHaveLength(1)
    expect(result.status).toBe('completed')
    expect(result.messages).toEqual([])
    expect(result.output_checks?.[0]).toMatchObject({ status: 'failed', attempts: 0, reason: 'repairs_exhausted' })
  })

  it('no block → absent, nothing happens', async () => {
    const model = mockModel([textAnswer('Just an answer without rules. I know the ```rule-card``` format.')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ output_checks: checks() } as never))

    expect(model.doStreamCalls).toHaveLength(1)
    expect(assistantText(result)).toBe('Just an answer without rules. I know the ```rule-card``` format.')
    expect(result.output_checks).toEqual([{ fence: FENCE, status: 'absent', attempts: 0 }])
  })

  it('invalid JSON is repaired the same way; a block with <|superquote|> passes as is', async () => {
    const broken = mockModel([
      textAnswer(`Here:\n${fenced('{"rules": [')}`),
      textAnswer(fenced(GOOD_BLOCK)),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(broken) }))
    const repaired = await runWait(engine, runRequest({ output_checks: checks() } as never))
    expect(repaired.output_checks?.[0]).toMatchObject({ status: 'repaired', errors: [expect.stringMatching(/^JSON did not parse/)] })
    expect(promptText(broken, 1, 'user')).toContain('- JSON did not parse:')

    const quoted = `Here:\n\n${fenced(GOOD_BLOCK.replaceAll('"', '<|superquote|>'))}`
    const model = mockModel([textAnswer(quoted)])
    const engine2 = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))
    const passed = await runWait(engine2, runRequest({ output_checks: checks() } as never))
    expect(passed.output_checks?.[0]!.status).toBe('passed')
    expect(assistantText(passed)).toBe(quoted)
  })

  it('a step with a tool call is not checked — only the final text', async () => {
    const tools = trackServer(await startServer((_b, _r, res) => json(res, 200, { status: 'ok', result: { rules: [] } })))
    const interim = `Let me look at the current rules first.\n${fenced(BAD_BLOCK)}`
    const model = mockModel([
      streamFrom([START, ...textChunks(interim), toolCall('c1', 'getInboxRules', {}), finish('tool-calls')]),
      textAnswer('There are no rules yet.'),
    ])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ tools: [readTool(tools.url)] as never, output_checks: checks() } as never))

    expect(model.doStreamCalls).toHaveLength(2)
    expect(result.output_checks).toEqual([{ fence: FENCE, status: 'absent', attempts: 0 }])
    // the intermediate answer is left alone
    expect(JSON.stringify(result.messages[0])).toContain('Let me look at the current rules first.')
    expect((result.messages[0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe(interim)
  })

  it('several fences: each on its own, repaired blocks in output_checks order', async () => {
    const notesSchema = { type: 'object', required: ['ok'], properties: { ok: { const: true } } }
    const original = `Text.\n\n${fenced('{"ok": false}', 'notes')}\n\n${fenced(GOOD_BLOCK)}`
    const model = mockModel([textAnswer(original), textAnswer(fenced('{"ok": true}', 'notes'))])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ output_checks: [{ fence: 'notes', schema: notesSchema }, ...checks()] } as never),
    )

    expect(result.output_checks!.map((c) => [c.fence, c.status])).toEqual([
      ['notes', 'repaired'],
      [FENCE, 'passed'],
    ])
    expect(assistantText(result)).toBe(`Text.\n\n${fenced(GOOD_BLOCK)}\n\n${fenced('{"ok": true}', 'notes')}`)
    expect(promptText(model, 1, 'user')).toContain('- /ok: must be equal to constant: true')
  })

  it('the run never reached the final text → output_checks: []', async () => {
    const model = mockModel([streamFrom([START, toolCall('c1', 'getInboxRules', {}), finish('tool-calls')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool()] as never, limits: { max_steps: 1 } as never, output_checks: checks() } as never),
    )

    expect(result.status).toBe('stopped_limit')
    expect(result.output_checks).toEqual([])
  })

  it('without output_checks — as before: no field in the result, the text with a broken block is untouched', async () => {
    const original = `${INTRO}\n\n${fenced(BAD_BLOCK)}`
    const model = mockModel([textAnswer(original)])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest())

    expect(model.doStreamCalls).toHaveLength(1)
    expect(assistantText(result)).toBe(original)
    expect('output_checks' in result).toBe(false)
  })
})

describe('output_checks: limits during repair', () => {
  it('the max_total_tokens budget denies the repair → completed, block cut, failed', async () => {
    // the first answer reported 5500 input tokens — not enough left for a repair step with the max_tokens reserve
    const model = mockModel([textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`, { inputTokens: 5500 })])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ limits: { max_total_tokens: 6000, max_tokens: 500 } as never, output_checks: checks() } as never),
    )

    expect(model.doStreamCalls).toHaveLength(1)
    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    expect(assistantText(result)).toBe(INTRO)
    expect(result.output_checks?.[0]).toMatchObject({ status: 'failed', attempts: 1, reason: 'max_total_tokens' })
  })

  it('run timeout during repair → completed, block cut, failed / run_timeout', async () => {
    let call = 0
    const model = mockModel(async ({ abortSignal }) => {
      call++
      if (call === 1) return textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`)
      return hangingStream([START, ...textChunks('```rule-card\n{"rules')], abortSignal)
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ limits: { timeout_ms: 300 } as never, output_checks: checks() } as never))

    expect(call).toBe(2)
    expect(result.status).toBe('completed')
    expect(result.finish_reason).toBe('end_turn')
    expect(result.error).toBeNull()
    expect(assistantText(result)).toBe(INTRO)
    expect(result.output_checks?.[0]).toMatchObject({ status: 'failed', attempts: 1, reason: 'run_timeout' })
    // the interrupted repair attempt is in usage as unknown
    expect(result.usage.calls.map((c) => c.status)).toEqual(['ok', 'unknown'])
  })

  it('cancel during repair → cancelled, text without the block, failed / cancelled', async () => {
    let call = 0
    const model = mockModel(async ({ abortSignal }) => {
      call++
      if (call === 1) return textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`)
      return hangingStream([START, ...textChunks('```rule-card\n')], abortSignal)
    })
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const callbacks = trackServer(await startServer((_b, _r, r) => json(r, 200, { ok: true })))
    const accepted = (await (
      await post(engine, { ...runRequest({ output_checks: checks() } as never), wait: false, callback: { url: `${callbacks.url}/cb` } })
    ).json()) as { run_id: string }

    await waitFor(() => call === 2)
    const cancelled = await engine.app.request(`/runs/${accepted.run_id}/cancel`, { method: 'POST', headers: bearer() })
    const result = (await cancelled.json()) as RunResult

    expect(result.status).toBe('cancelled')
    expect(result.finish_reason).toBe('user')
    expect(assistantText(result)).toBe(INTRO)
    expect(result.messages[0]).not.toHaveProperty('partial')
    expect(result.output_checks?.[0]).toMatchObject({ status: 'failed', attempts: 1, reason: 'cancelled' })
  })
})

describe('output_checks: HTTP, SSE, callback, journal', () => {
  it('broken schema → 400 output_check_schema_invalid; more than 4 checks → 400', async () => {
    const model = mockModel([textAnswer('must not be called')])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const bad = await post(engine, runRequest({ output_checks: [{ fence: FENCE, schema: { type: 'nonsense' } }] } as never))
    expect(bad.status).toBe(400)
    const body = (await bad.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toMatch(/^output_check_schema_invalid: rule-card: /)

    const many = Array.from({ length: 5 }, (_, i) => ({ fence: `f${i}`, schema: { type: 'object' } }))
    expect((await post(engine, runRequest({ output_checks: many } as never))).status).toBe(400)
    const badFence = await post(engine, runRequest({ output_checks: [{ fence: 'Rule Card', schema: {} }] } as never))
    expect(badFence.status).toBe(400)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('SSE: step → output_check repairing → repair deltas after a separator → repaired → done', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let call = 0
    const model = mockModel(async () => {
      call++
      if (call === 1) {
        await gate
        return textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`)
      }
      return textAnswer(fenced(FIXED_BLOCK))
    })
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const accepted = (await (
      await post(engine, {
        ...runRequest({ output_checks: checks() } as never),
        wait: false,
        callback: { url: `${callbacks.url}/cb` },
      })
    ).json()) as { run_id: string; stream_url: string }
    const url = new URL(accepted.stream_url)
    // Last-Event-ID: 0 — replay from the very start while the run is still going
    const stream = await engine.app.request(url.pathname + url.search, { headers: { 'Last-Event-ID': '0' } })
    release()
    const events = parseSse(await readSseUntil(stream, (b) => b.includes('event: done')))

    const names = events.map((e) => e.event)
    expect(names).toEqual(['start', 'delta', 'step', 'output_check', 'delta', 'delta', 'output_check', 'done'])
    expect(events[3]!.data).toEqual({ fence: FENCE, attempt: 1, status: 'repairing', errors: ['/rules/0/predicates'] })
    expect(events[4]!.data).toEqual({ text: '\n\n' })
    expect(events[5]!.data).toEqual({ text: fenced(FIXED_BLOCK) })
    expect(events[6]!.data).toEqual({ fence: FENCE, attempt: 1, status: 'repaired' })
    expect(events[7]!.data.status).toBe('completed')

    // reconnect after the terminal status: the snapshot carries the gate state
    const again = await engine.app.request(url.pathname + url.search)
    const replay = parseSse(await readSseUntil(again, (b) => b.includes('event: done')))
    expect(replay[0]!.event).toBe('snapshot')
    expect(replay[0]!.data.output_checks).toEqual([{ fence: FENCE, attempt: 1, status: 'repaired' }])
  })

  it('SSE: failed repair — output_check failed with error paths', async () => {
    const model = mockModel([textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`), textAnswer('no block')])
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const accepted = (await (
      await post(engine, { ...runRequest({ output_checks: checks() } as never), wait: false, callback: { url: `${callbacks.url}/cb` } })
    ).json()) as { stream_url: string }
    await waitFor(() => callbacks.requests.length > 0)
    const url = new URL(accepted.stream_url)
    const replay = parseSse(await readSseUntil(await engine.app.request(url.pathname + url.search), (b) => b.includes('event: done')))
    expect(replay[0]!.data.output_checks).toEqual([{ fence: FENCE, attempt: 1, status: 'failed' }])
    expect(replay[0]!.data.text).toBe(`${INTRO}\n\n${fenced(BAD_BLOCK)}\n\nno block`)
  })

  it('callback and GET carry output_checks; the journal has an output_check event per attempt', async () => {
    const model = mockModel([
      textAnswer(`${INTRO}\n\n${fenced(BAD_BLOCK)}`),
      textAnswer(fenced(FIXED_BLOCK)),
    ])
    const callbacks = trackServer(await startServer((_b, _r, res) => json(res, 200, { ok: true })))
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const accepted = (await (
      await post(engine, { ...runRequest({ output_checks: checks() } as never), wait: false, callback: { url: `${callbacks.url}/cb` } })
    ).json()) as { run_id: string }
    await waitFor(() => callbacks.requests.length > 0)

    const payload = (callbacks.requests[0]!.body as { payload: RunResult }).payload
    expect(payload.output_checks).toEqual([
      { fence: FENCE, status: 'repaired', attempts: 1, errors: [expect.stringMatching(/^\/rules\/0\/predicates/)] },
    ])
    const got = (await (await engine.app.request(`/runs/${accepted.run_id}`, { headers: bearer() })).json()) as RunResult
    expect(got.output_checks).toEqual(payload.output_checks)

    const logs = (await (
      await engine.app.request(`/runs/${accepted.run_id}/logs?event=output_check`, { headers: bearer() })
    ).json()) as { entries: Array<Record<string, any>> }
    expect(logs.entries.map((e) => [e.fence, e.attempt, e.outcome])).toEqual([
      [FENCE, 0, 'invalid'],
      [FENCE, 1, 'repaired'],
    ])
    expect(logs.entries[0]!.errors).toEqual(['/rules/0/predicates'])
    expect(logs.entries[0]!.content.issues[0]).toMatch(/^\/rules\/0\/predicates: /)
    expect(logs.entries[0]!.content.block).toContain('"predicates"')
    expect(logs.entries[1]!.content.draft).toBe(fenced(FIXED_BLOCK))

    // the repair attempt is marked in the provider journal
    const attempts = (await (
      await engine.app.request(`/runs/${accepted.run_id}/logs?event=provider_attempt`, { headers: bearer() })
    ).json()) as { entries: Array<Record<string, any>> }
    expect(attempts.entries.map((e) => e.repair ?? null)).toEqual([null, FENCE])
  })
})
