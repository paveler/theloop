/**
 * Text the engine writes itself (SPEC Appendix B): lines in the model prompt — dates,
 * the empty-result marker, repeated_call, invalid_tool_input reasons, the block repair
 * message — and the `error.message` of a failed run. Run locale — `meta.locale`, else
 * env ENGINE_LOCALE, else DEFAULT_LOCALE. Machine fields (code, status, journal events,
 * error paths) do not depend on the locale. 4xx refusals, config errors and log text
 * are not in the catalog.
 */
import { createRequire } from 'node:module'
import type { ErrorObject } from 'ajv/dist/2020.js'

export const LOCALES = ['ru', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Locale when neither meta.locale nor ENGINE_LOCALE is set. */
export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export interface Texts {
  /* dates (§9.4) */
  messageDate(stamp: string, timezone: string): string
  currentDate(stamp: string, timezone: string): string

  /* tools (§6.1, §6.2, §6.7) */
  emptyToolResult: string
  repeatedCall: string
  invalidCall: string
  invalidCallArgs: string
  argsRoot: string
  argNotInEnum(where: string): string
  argWrongType(where: string, expected: string, got: string): string
  argWrongTypeOneOf(where: string, expected: readonly string[], got: string): string
  argMissingField(where: string, key: string): string
  argMinItems(where: string, min: number): string

  /* skills and deferred tools (§6.8); machine prefixes and names do not depend on the locale */
  skillIndexHeader: string
  loadSkillDescription: string
  loadSkillNameDescription: string
  skillLoaded(name: string, tools: readonly string[]): string
  unknownSkill(name: string, available: readonly string[]): string
  toolNotLoadedSkill(tool: string, skill: string): string
  toolNotLoaded(tool: string): string
  searchToolsDescription: string
  searchQueryDescription: string
  searchLimitDescription: string
  searchResult(tools: readonly string[], inSkills: ReadonlyArray<readonly [string, string]>): string
  searchNoMatch(query: string): string

  /* format gate (§5.4); field names arrive already quoted */
  checkHeader(fence: string): string
  checkFooter(fence: string): string
  blockUnclosed: string
  blockMissing(fence: string): string
  jsonNotParsed(reason: string): string
  andMore(count: number): string
  fieldRequired(name: string): string
  atLeastOneField(names: readonly string[]): string
  keyNotRecognized(key: string): string
  onlyOneField(names: readonly string[], present: readonly string[]): string
  mustBeTypes(types: readonly string[]): string
  tagInvalidValue(tag: string, value: string): string
  cannotBe(type: string): string
  oneOfMismatch: string
  anyOfMismatch: string
  /** ajv messages in the locale; in place. */
  localizeAjv(errors: ErrorObject[]): void

  /* error.message of a failed run (§7) */
  internalError: string
  runTimeout(ms: number): string
  queueTimeout(provider: string, waitedMs: number, queueDepth: number, limit: number): string
  streamWithoutFinish: string
  contextTooLarge: string
  providerKeyRejected: string
  providerForbidden: string
  providerRateLimited: string
  providerUnavailable(status: number): string
  providerRejected(status: number): string
  providerTls: string
  imageFetchFailed(reason: string): string
}

// ajv-i18n is CommonJS with `module.exports = fn`, while its d.ts declares a default export:
// under NodeNext a default import is typed apart from the runtime, hence require
const require = createRequire(import.meta.url)
const localizeRu = require('ajv-i18n/localize/ru') as (errors: ErrorObject[] | null | undefined) => void

const ru: Texts = {
  messageDate: (stamp, timezone) => `[engine] Дата и время сообщения: ${stamp} (${timezone}).`,
  currentDate: (stamp, timezone) => `[engine] Текущая дата и время: ${stamp} (${timezone}).`,

  emptyToolResult:
    '[engine] Тул отработал успешно и вернул пустой результат — данных нет. ' +
    'Повторный вызов с теми же аргументами вернёт то же самое.',
  repeatedCall:
    'repeated_call: этот вызов с теми же аргументами уже выполнен в этом run, его результат выше. ' +
    'Повтор вернёт то же самое — используй имеющийся результат или ответь пользователю.',
  invalidCall: 'невалидный вызов',
  invalidCallArgs: 'невалидные аргументы вызова',
  argsRoot: 'аргументы',
  argNotInEnum: (where) => `${where}: значение вне enum`,
  argWrongType: (where, expected, got) => `${where}: ожидался ${expected}, пришло ${got}`,
  argWrongTypeOneOf: (where, expected, got) => `${where}: ожидался один из [${expected.join(', ')}], пришло ${got}`,
  argMissingField: (where, key) => `${where}: нет обязательного поля "${key}"`,
  argMinItems: (where, min) => `${where}: нужно минимум ${min} элементов`,

  skillIndexHeader:
    '[engine] Скиллы. Прежде чем браться за тему, которую покрывает скилл, вызови load_skill с его ' +
    'именем: инструкции и тулы скилла придут на следующем шаге.',
  loadSkillDescription:
    'Загрузить скилл из списка в системном промпте: возвращает его инструкции, а его тулы ' +
    'становятся доступны со следующего шага.',
  loadSkillNameDescription: 'Имя скилла, ровно как в списке.',
  skillLoaded: (name, tools) =>
    tools.length > 0
      ? `[engine] Скилл "${name}" загружен. Тулы, доступные со следующего шага: ${tools.join(', ')}.`
      : `[engine] Скилл "${name}" загружен.`,
  unknownSkill: (name, available) => `unknown_skill: ${name}. Доступные скиллы: ${available.join(', ')}.`,
  toolNotLoadedSkill: (tool, skill) =>
    `tool_not_loaded: ${tool} входит в скилл "${skill}". Сначала вызови load_skill("${skill}").`,
  toolNotLoaded: (tool) => `tool_not_loaded: ${tool} не загружен. Сначала найди его через search_tools.`,
  searchToolsDescription:
    'Найти тулы, которые ещё не загружены, по тому, что они делают. Найденные тулы становятся ' +
    'доступны со следующего шага.',
  searchQueryDescription: 'Что должен делать тул, в нескольких словах.',
  searchLimitDescription: 'Сколько тулов вернуть (от 1 до 20, по умолчанию 5).',
  searchResult: (tools, inSkills) =>
    [
      tools.length > 0 ? `Тулы, доступные со следующего шага: ${tools.join(', ')}.` : null,
      inSkills.length > 0
        ? `Входят в скиллы, сначала загрузи скилл: ${inSkills.map(([t, s]) => `${t} (${s})`).join(', ')}.`
        : null,
    ]
      .filter((line) => line !== null)
      .map((line, i) => (i === 0 ? `[engine] ${line}` : line))
      .join('\n'),
  searchNoMatch: (query) => `[engine] Ни один тул не подходит под "${query}". Попробуй описать, что должен делать тул, другими словами.`,

  checkHeader: (fence) => `[Проверка формата] Блок ${fence} не прошёл проверку:`,
  checkFooter: (fence) => `Пришли только исправленный блок \`\`\`${fence}\`\`\`, без текста до и после.`,
  blockUnclosed: 'блок не закрыт: после JSON нет строки ```',
  blockMissing: (fence) => `в ответе нет блока \`\`\`${fence}`,
  jsonNotParsed: (reason) => `JSON не разобрался: ${reason}`,
  andMore: (count) => `…и ещё ${count}`,
  fieldRequired: (name) => `должно быть поле ${name}`,
  atLeastOneField: (names) => `должно быть хотя бы одно из полей ${names.join(', ')}`,
  keyNotRecognized: (key) => `ключ ${key} не распознан`,
  onlyOneField: (names, present) => `допустимо только одно из полей ${names.join(', ')}, а заданы ${present.join(' и ')}`,
  mustBeTypes: (types) => `должно быть ${types.join(' или ')}`,
  tagInvalidValue: (tag, value) => `поле ${tag}: недопустимое значение ${value}`,
  cannotBe: (type) => `не может быть ${type}`,
  oneOfMismatch: 'должно подходить ровно под один вариант схемы',
  anyOfMismatch: 'должно подходить хотя бы под один вариант схемы',
  localizeAjv: (errors) => localizeRu(errors),

  internalError: 'внутренняя ошибка движка',
  runTimeout: (ms) => `run не уложился в ${ms} мс`,
  queueTimeout: (provider, waitedMs, queueDepth, limit) =>
    `не дождались слота провайдера ${provider} за ${waitedMs} мс (очередь ${queueDepth}, потолок ${limit})`,
  streamWithoutFinish: 'стрим завершился без finish-step',
  contextTooLarge: 'контекст не помещается в окно модели',
  providerKeyRejected: 'провайдер отверг ключ (HTTP 401)',
  providerForbidden: 'провайдер отказал в доступе (HTTP 403): у ключа нет прав или регион заблокирован',
  providerRateLimited: 'провайдер ограничил частоту (HTTP 429)',
  providerUnavailable: (status) => `провайдер недоступен (HTTP ${status})`,
  providerRejected: (status) => `провайдер отверг запрос (HTTP ${status})`,
  providerTls:
    'TLS: цепочка сертификатов провайдера не проверяется. Для ГигаЧата нужен CA НУЦ ' +
    'Минцифры в образе и NODE_EXTRA_CA_CERTS (certs/README.md).',
  imageFetchFailed: (reason) => `не удалось скачать изображение: ${reason}`,
}

const en: Texts = {
  messageDate: (stamp, timezone) => `[engine] Message date and time: ${stamp} (${timezone}).`,
  currentDate: (stamp, timezone) => `[engine] Current date and time: ${stamp} (${timezone}).`,

  emptyToolResult:
    '[engine] The tool succeeded and returned an empty result — there is no data. ' +
    'Calling it again with the same arguments will return the same.',
  repeatedCall:
    'repeated_call: this exact call was already executed in this run; its result is above. ' +
    'Repeating it returns the same — use the result you have or answer the user.',
  invalidCall: 'invalid call',
  invalidCallArgs: 'invalid call arguments',
  argsRoot: 'arguments',
  argNotInEnum: (where) => `${where}: value is not in enum`,
  argWrongType: (where, expected, got) => `${where}: expected ${expected}, got ${got}`,
  argWrongTypeOneOf: (where, expected, got) => `${where}: expected one of [${expected.join(', ')}], got ${got}`,
  argMissingField: (where, key) => `${where}: missing required field "${key}"`,
  argMinItems: (where, min) => `${where}: at least ${min} items required`,

  skillIndexHeader:
    '[engine] Skills. Before working on a topic a skill covers, call load_skill with its name: ' +
    'the instructions, and the tools the skill unlocks, arrive on the next step.',
  loadSkillDescription:
    'Load a skill listed in the system prompt: returns its instructions and makes its tools ' +
    'available from the next step.',
  loadSkillNameDescription: 'Skill name, exactly as listed.',
  skillLoaded: (name, tools) =>
    tools.length > 0
      ? `[engine] Skill "${name}" loaded. Tools available from the next step: ${tools.join(', ')}.`
      : `[engine] Skill "${name}" loaded.`,
  unknownSkill: (name, available) => `unknown_skill: ${name}. Available skills: ${available.join(', ')}.`,
  toolNotLoadedSkill: (tool, skill) =>
    `tool_not_loaded: ${tool} belongs to skill "${skill}". Call load_skill("${skill}") first.`,
  toolNotLoaded: (tool) => `tool_not_loaded: ${tool} is not loaded. Find it with search_tools first.`,
  searchToolsDescription:
    'Find tools that are not loaded yet, by what they do. Matching tools become available from ' +
    'the next step.',
  searchQueryDescription: 'What the tool should do, in a few words.',
  searchLimitDescription: 'How many tools to return (1 to 20, default 5).',
  searchResult: (tools, inSkills) =>
    [
      tools.length > 0 ? `Tools available from the next step: ${tools.join(', ')}.` : null,
      inSkills.length > 0
        ? `Part of skills, load the skill first: ${inSkills.map(([t, s]) => `${t} (${s})`).join(', ')}.`
        : null,
    ]
      .filter((line) => line !== null)
      .map((line, i) => (i === 0 ? `[engine] ${line}` : line))
      .join('\n'),
  searchNoMatch: (query) => `[engine] No tools match "${query}". Try other words for what the tool should do.`,

  checkHeader: (fence) => `[Format check] The ${fence} block failed validation:`,
  checkFooter: (fence) => `Send only the corrected \`\`\`${fence}\`\`\` block, with no text before or after.`,
  blockUnclosed: 'the block is not closed: no ``` line after the JSON',
  blockMissing: (fence) => `the answer has no \`\`\`${fence} block`,
  jsonNotParsed: (reason) => `JSON did not parse: ${reason}`,
  andMore: (count) => `…and ${count} more`,
  fieldRequired: (name) => `must have field ${name}`,
  atLeastOneField: (names) => `must have at least one of fields ${names.join(', ')}`,
  keyNotRecognized: (key) => `key ${key} is not recognized`,
  onlyOneField: (names, present) => `only one of fields ${names.join(', ')} is allowed, but ${present.join(' and ')} are set`,
  mustBeTypes: (types) => `must be ${types.join(' or ')}`,
  tagInvalidValue: (tag, value) => `field ${tag}: invalid value ${value}`,
  cannotBe: (type) => `cannot be ${type}`,
  oneOfMismatch: 'must match exactly one schema variant',
  anyOfMismatch: 'must match at least one schema variant',
  // ajv messages are English by default
  localizeAjv: () => {},

  internalError: 'internal engine error',
  runTimeout: (ms) => `the run did not finish within ${ms} ms`,
  queueTimeout: (provider, waitedMs, queueDepth, limit) =>
    `no ${provider} provider slot within ${waitedMs} ms (queue ${queueDepth}, limit ${limit})`,
  streamWithoutFinish: 'the stream ended without finish-step',
  contextTooLarge: 'the context does not fit the model window',
  providerKeyRejected: 'the provider rejected the key (HTTP 401)',
  providerForbidden: 'the provider denied access (HTTP 403): the key lacks permissions or the region is blocked',
  providerRateLimited: 'the provider rate-limited the request (HTTP 429)',
  providerUnavailable: (status) => `the provider is unavailable (HTTP ${status})`,
  providerRejected: (status) => `the provider rejected the request (HTTP ${status})`,
  providerTls:
    'TLS: the provider certificate chain does not verify. GigaChat needs the Russian Trusted ' +
    'Root CA in the image and NODE_EXTRA_CA_CERTS (certs/README.md).',
  imageFetchFailed: (reason) => `failed to download the image: ${reason}`,
}

const CATALOGS: Record<Locale, Texts> = { ru, en }

export function texts(locale: Locale = DEFAULT_LOCALE): Texts {
  return CATALOGS[locale]
}

/**
 * Run locale: `meta.locale`, else the engine default (env ENGINE_LOCALE). An unknown
 * value in meta → the engine default, plus `requested` for a warning in the journal.
 */
export function resolveLocale(
  requested: unknown,
  engineDefault: Locale,
): { locale: Locale; unsupported?: string } {
  if (requested === undefined || requested === null || requested === '') return { locale: engineDefault }
  if (isLocale(requested)) return { locale: requested }
  return { locale: engineDefault, unsupported: String(requested).slice(0, 40) }
}
