/**
 * Engine text locale (SPEC Appendix B) and the default time zone (§9.4): meta.locale,
 * env ENGINE_LOCALE, env DEFAULT_TIMEZONE. Defaults are en and UTC; ru is the same
 * catalog in Russian.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import { createConfig, DEFAULT_TIMEZONE } from '../src/config.js'
import type { RunResult } from '../src/contracts.js'
import { DEFAULT_LOCALE, LOCALES, resolveLocale, texts, type Locale } from '../src/i18n.js'
import { compileOutputChecks, checkText, repairPrompt } from '../src/runs/output-checks.js'
import { engineDateLine, messageDateLine } from '../src/runs/messages.js'
import { validateToolArgs } from '../src/tools/args.js'
import {
  bearer,
  ENGINE_TOKEN,
  finish,
  json,
  mockFactory,
  mockModel,
  runRequest,
  START,
  startServer,
  streamFrom,
  textChunks,
  testConfig,
  toolCall,
  type LocalServer,
} from './helpers.js'

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

async function runWait(engine: Engine, body: Record<string, unknown>): Promise<RunResult> {
  const res = await engine.app.request('/runs', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ ...body, wait: true }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as RunResult
}

function readTool(url: string, name = 'getStatus') {
  return {
    name,
    description: 'test',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    endpoint: `${url}/${name}`,
    effect: 'read' as const,
  }
}

function lastUserText(model: ReturnType<typeof mockModel>, step: number): string {
  const users = model.doStreamCalls[step]!.prompt.filter((m) => m.role === 'user')
  const content = users.at(-1)!.content as Array<{ type: string; text?: string }>
  return content.map((p) => p.text ?? '').join('')
}

/** The current-time line of a locale as a pattern anchored at the end, stamp as \S+. */
function currentDateLine(locale: Locale, timezone: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [before, after] = texts(locale).currentDate('<stamp>', timezone).split('<stamp>')
  return new RegExp(`${escape(before!)}\\S+${escape(after!)}$`)
}

const CYRILLIC = /[\u0400-\u04FF]/

function toolOutputsAt(model: ReturnType<typeof mockModel>, step: number): unknown[] {
  return model.doStreamCalls[step]!.prompt
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as Array<{ output: unknown }>)
    .map((p) => p.output)
}

describe('locale: catalogs and selection', () => {
  it('ru and en have the same set of texts', () => {
    const keys = LOCALES.map((locale) => Object.keys(texts(locale)).sort())
    for (const set of keys) expect(set).toEqual(keys[0])
  })

  it('meta.locale wins over the engine default; an unsupported one falls back to the default with a flag', () => {
    expect(resolveLocale(undefined, 'ru')).toEqual({ locale: 'ru' })
    expect(resolveLocale('', 'en')).toEqual({ locale: 'en' })
    expect(resolveLocale('en', 'ru')).toEqual({ locale: 'en' })
    expect(resolveLocale('ru', 'en')).toEqual({ locale: 'ru' })
    expect(resolveLocale('de', 'en')).toEqual({ locale: 'en', unsupported: 'de' })
    expect(resolveLocale('de', 'ru')).toEqual({ locale: 'ru', unsupported: 'de' })
  })

  it('env: defaults are en and UTC, invalid values stop the engine at startup', () => {
    const base = { ENGINE_TOKEN }
    expect(DEFAULT_LOCALE).toBe('en')
    expect(DEFAULT_TIMEZONE).toBe('UTC')
    expect(texts()).toBe(texts('en'))
    expect(createConfig(base)).toMatchObject({ engineLocale: 'en', defaultTimezone: 'UTC' })
    expect(createConfig({ ...base, ENGINE_LOCALE: 'ru', DEFAULT_TIMEZONE: 'Europe/Berlin' })).toMatchObject({
      engineLocale: 'ru',
      defaultTimezone: 'Europe/Berlin',
    })
    expect(() => createConfig({ ...base, ENGINE_LOCALE: 'de' })).toThrow(/ENGINE_LOCALE/)
    expect(() => createConfig({ ...base, DEFAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(/DEFAULT_TIMEZONE/)
  })
})

describe('locale: en texts', () => {
  it('date lines', () => {
    const en = texts('en')
    expect(engineDateLine('UTC', new Date('2026-09-03T09:00:00Z'), en)).toBe(
      '[engine] Current date and time: 2026-09-03T09:00:00+00:00 (UTC).',
    )
    expect(messageDateLine('2026-10-12T12:03:21.500Z', 'Europe/Berlin', en)).toBe(
      '[engine] Message date and time: 2026-10-12T14:03:21+02:00 (Europe/Berlin).',
    )
  })

  it('invalid_tool_input reasons', () => {
    const en = texts('en')
    const schema = { type: 'object', required: ['id'], properties: { n: { type: 'integer' } } }
    expect(validateToolArgs(schema, {}, en)).toEqual({ ok: false, reason: 'arguments: missing required field "id"' })
    expect(validateToolArgs(schema, { id: 'x', n: 'a' }, en)).toEqual({ ok: false, reason: 'n: expected integer, got string' })
  })

  it('format gate: the repair message and ajv errors are in English', () => {
    const [check] = compileOutputChecks([
      { fence: 'action-card', schema: { type: 'object', required: ['kind'], properties: { kind: { enum: ['link'] } } } },
    ])
    const en = texts('en')
    const verdict = checkText('Done.\n\n```action-card\n{"kind":"call"}\n```', check!, en)
    expect(verdict.kind).toBe('invalid')
    const prompt = repairPrompt('action-card', verdict.kind === 'invalid' ? verdict.issues : [], en)
    expect(prompt.split('\n')).toEqual([
      '[Format check] The action-card block failed validation:',
      '- /kind: must be equal to one of the allowed values: "link"',
      'Send only the corrected ```action-card``` block, with no text before or after.',
    ])
    const broken = checkText('```action-card\n{"kind": \n```', check!, en)
    expect(broken.kind === 'invalid' && broken.issues[0]!.message).toMatch(/^JSON did not parse: /)
  })
})

describe('locale: in the loop', () => {
  /** Two identical calls returning an empty result: the empty marker, then repeated_call. */
  function repeatingModel() {
    return mockModel([
      streamFrom([START, toolCall('c1', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, toolCall('c2', 'getStatus', { id: '1' }), finish('tool-calls')]),
      streamFrom([START, ...textChunks('No data.'), finish('stop')]),
    ])
  }

  async function emptyTools(): Promise<LocalServer> {
    return trackServer(await startServer((_body, _req, res) => json(res, 200, { status: 'ok', result: [] })))
  }

  it('meta.locale ru: the empty-result marker, repeated_call and the date line are in Russian', async () => {
    const tools = await emptyTools()
    const model = repeatingModel()
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)], meta: { locale: 'ru', timezone: 'UTC' } } as never),
    )

    expect(result.status).toBe('completed')
    expect(toolOutputsAt(model, 1)).toEqual([{ type: 'text', value: texts('ru').emptyToolResult }])
    const repeat = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c2') as Record<string, any>
    expect(repeat.error).toBe(texts('ru').repeatedCall)
    const text = lastUserText(model, 0)
    expect(text.startsWith('hello\n\n')).toBe(true)
    expect(text).toMatch(currentDateLine('ru', 'UTC'))
    expect(text).toMatch(CYRILLIC)
  })

  it('meta.locale en wins over ENGINE_LOCALE=ru: marker, repeated_call and date line are in English', async () => {
    const tools = await emptyTools()
    const model = repeatingModel()
    const engine = track(createEngine(testConfig({ ENGINE_LOCALE: 'ru' }), { modelFactory: mockFactory(model) }))

    const result = await runWait(
      engine,
      runRequest({ tools: [readTool(tools.url)], meta: { locale: 'en', timezone: 'UTC' } } as never),
    )

    expect(result.status).toBe('completed')
    expect(toolOutputsAt(model, 1)).toEqual([{ type: 'text', value: texts('en').emptyToolResult }])
    const repeat = result.messages.find((m) => m.role === 'tool' && m.call_id === 'c2') as Record<string, any>
    expect(repeat.error).toBe(texts('en').repeatedCall)
    expect(lastUserText(model, 0)).toMatch(/^hello\n\n\[engine\] Current date and time: \S+ \(UTC\)\.$/)
  })

  it('ENGINE_LOCALE=ru and DEFAULT_TIMEZONE from env apply when meta has none', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const config = testConfig({ ENGINE_LOCALE: 'ru', DEFAULT_TIMEZONE: 'America/New_York' })
    const engine = track(createEngine(config, { modelFactory: mockFactory(model) }))

    await runWait(engine, runRequest())

    const text = lastUserText(model, 0)
    expect(text).toMatch(currentDateLine('ru', 'America/New_York'))
    expect(text).toMatch(CYRILLIC)
  })

  it('without env and meta: English text and UTC', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    await runWait(engine, runRequest())

    expect(lastUserText(model, 0)).toMatch(
      /^hello\n\n\[engine\] Current date and time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 \(UTC\)\.$/,
    )
  })

  it('an unsupported meta.locale falls back to the engine default (en), the journal gets locale_unsupported', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig(), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ meta: { locale: 'de' } } as never))

    expect(result.status).toBe('completed')
    expect(lastUserText(model, 0)).toContain('[engine] Current date and time')
    const res = await engine.app.request(`/runs/${result.run_id}/logs?event=locale_unsupported`, { headers: bearer() })
    const { entries } = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn', requested: 'de', locale: 'en' })
  })

  it('with ENGINE_LOCALE=ru an unsupported meta.locale falls back to ru', async () => {
    const model = mockModel([streamFrom([START, ...textChunks('ok'), finish('stop')])])
    const engine = track(createEngine(testConfig({ ENGINE_LOCALE: 'ru' }), { modelFactory: mockFactory(model) }))

    const result = await runWait(engine, runRequest({ meta: { locale: 'de', timezone: 'UTC' } } as never))

    expect(result.status).toBe('completed')
    expect(lastUserText(model, 0)).toMatch(currentDateLine('ru', 'UTC'))
    const res = await engine.app.request(`/runs/${result.run_id}/logs?event=locale_unsupported`, { headers: bearer() })
    const { entries } = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(entries[0]).toMatchObject({ level: 'warn', requested: 'de', locale: 'ru' })
  })
})
