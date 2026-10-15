/**
 * Format gate for structured blocks in the model's final answer (SPEC §5.4).
 *
 * The model ends its answer with a ```<fence> block holding JSON, and the client UI
 * renders a card from it. Everything here is outside the loop: compiling the JSON
 * Schema from the request, finding the block in the text (the same semantics as the
 * client UI), validation and errors for the model. Repair steps are driven by runner.ts.
 */
import { createHash } from 'node:crypto'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { OUTPUT_CHECK_LIMITS, type OutputCheckInput } from '../contracts.js'
import { EngineError } from '../errors.js'
import { texts, type Texts } from '../i18n.js'

/** GigaChat service token in place of a quote — a tokenizer artifact, not meaning. */
const SUPERQUOTE = '<|superquote|>'

/** Error lines in the message to the model and in the run result. */
export const MAX_ISSUE_LINES = 8

/** Compiled schemas kept: the harness sends the same schema in every run. */
const COMPILE_CACHE_MAX = 16

/** Paths of "errors" outside the schema — the client tells them apart from JSON paths in SSE. */
export const ISSUE_JSON = 'json'
export const ISSUE_UNCLOSED = 'block_unclosed'
export const ISSUE_MISSING = 'block_missing'
const SPECIAL_PATHS = new Set([ISSUE_JSON, ISSUE_UNCLOSED, ISSUE_MISSING])

export interface CompiledOutputCheck {
  fence: string
  maxRepairs: number
  validate: ValidateFunction
}

export interface Issue {
  /** JSON Pointer in the block (`/actions/0`, `/` — the root) or json / block_unclosed / block_missing. */
  path: string
  message: string
}

export interface FencedBlock {
  /** Start of the opening line. */
  start: number
  /** End of the closing line including its newline; for an unclosed block, the end of the text. */
  end: number
  /** Content between the fences. */
  raw: string
  closed: boolean
}

export type BlockVerdict =
  | { kind: 'absent' }
  | { kind: 'valid'; block: FencedBlock; raw: string }
  | { kind: 'invalid'; block: FencedBlock; issues: Issue[] }

/* ------------------------------------------------------------ compilation */

const compileCache = new Map<string, ValidateFunction>()

/**
 * Checks from the request → compiled validators. A broken schema is a 400 when the
 * request is received, not a surprise at the end of the run.
 */
export function compileOutputChecks(inputs: readonly OutputCheckInput[] | null | undefined): CompiledOutputCheck[] {
  if (!inputs || inputs.length === 0) return []
  const seen = new Set<string>()
  return inputs.map((input, index) => {
    if (seen.has(input.fence)) {
      throw new EngineError('bad_request', `output_checks[${index}].fence: fence "${input.fence}" is already in the list`)
    }
    seen.add(input.fence)

    const serialized = JSON.stringify(input.schema)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > OUTPUT_CHECK_LIMITS.schema_max_bytes) {
      throw new EngineError(
        'bad_request',
        `output_check_schema_too_large: ${input.fence}: schema is ${bytes} bytes, limit ${OUTPUT_CHECK_LIMITS.schema_max_bytes}`,
      )
    }

    return {
      fence: input.fence,
      maxRepairs: Math.min(
        input.max_repairs ?? OUTPUT_CHECK_LIMITS.max_repairs_default,
        OUTPUT_CHECK_LIMITS.max_repairs_cap,
      ),
      validate: compileSchema(input.fence, serialized),
    }
  })
}

function compileSchema(fence: string, serialized: string): ValidateFunction {
  const key = createHash('sha256').update(serialized).digest('hex')
  const cached = compileCache.get(key)
  if (cached) {
    compileCache.delete(key)
    compileCache.set(key, cached)
    return cached
  }

  let validate: ValidateFunction
  try {
    // one instance per schema: two different documents with the same $id do not conflict.
    // verbose — schema / parentSchema / data are needed to untangle oneOf / anyOf
    const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: false, verbose: true, logger: false })
    // own copy — the validator does not hold a reference to the request body
    validate = ajv.compile(JSON.parse(serialized) as object)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new EngineError('bad_request', `output_check_schema_invalid: ${fence}: ${message.slice(0, 300)}`)
  }
  if ((validate as { $async?: boolean }).$async) {
    throw new EngineError('bad_request', `output_check_schema_invalid: ${fence}: $async schemas are not supported`)
  }

  compileCache.set(key, validate)
  if (compileCache.size > COMPILE_CACHE_MAX) compileCache.delete(compileCache.keys().next().value!)
  return validate
}

/* ------------------------------------------------------- block in the text */

interface Line {
  start: number
  /** Index past the newline (or the end of the text). */
  end: number
  text: string
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let pos = 0
  for (;;) {
    const nl = text.indexOf('\n', pos)
    const contentEnd = nl === -1 ? text.length : nl
    lines.push({ start: pos, end: nl === -1 ? text.length : nl + 1, text: text.slice(pos, contentEnd).replace(/\r$/, '') })
    if (nl === -1) return lines
    pos = nl + 1
  }
}

/**
 * All blocks of the fence, in order. Opening — a line that starts (after whitespace)
 * with ```<fence>, followed up to the end of the line by a space and an info string
 * without backticks, or by nothing: "```action-card``` is the format" in running text
 * is not a block. Closing — a line of ``` and whitespace. An unclosed opening swallows
 * the text to the end, so it can only be the last block.
 */
export function findBlocks(text: string, fence: string): FencedBlock[] {
  // fence is ^[a-z0-9-]+$ (contract), nothing to escape in the regex
  const open = new RegExp('^[ \\t]*```' + fence + '(?:[ \\t][^`]*)?$')
  const close = /^[ \t]*```[ \t]*$/
  const lines = splitLines(text)
  const blocks: FencedBlock[] = []

  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i]!
    if (!open.test(opening.text)) continue
    let j = i + 1
    while (j < lines.length && !close.test(lines[j]!.text)) j++
    if (j >= lines.length) {
      blocks.push({ start: opening.start, end: text.length, raw: text.slice(opening.end), closed: false })
      break
    }
    const closing = lines[j]!
    blocks.push({ start: opening.start, end: closing.end, raw: text.slice(opening.end, closing.start), closed: true })
    i = j
  }
  return blocks
}

/** Text without any blocks of the fence; extra blank lines at the seams are collapsed. */
export function stripBlocks(text: string, fence: string): string {
  const blocks = findBlocks(text, fence)
  if (blocks.length === 0) return text
  let out = ''
  let pos = 0
  for (const block of blocks) {
    out += text.slice(pos, block.start)
    pos = block.end
  }
  out += text.slice(pos)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function appendBlock(text: string, fence: string, raw: string): string {
  const block = '```' + fence + '\n' + raw.trim() + '\n```'
  return text.length > 0 ? `${text}\n\n${block}` : block
}

export function normalizeRaw(raw: string): string {
  return raw.split(SUPERQUOTE).join('"')
}

/**
 * Verdict on the LAST block of the fence, as in the client UI: the model sometimes
 * repeats the answer with the block twice, and the card is rendered from the last one.
 * An unclosed last block is a failure: the client UI will not render it.
 */
export function checkText(
  text: string,
  check: Pick<CompiledOutputCheck, 'validate'> & { fence: string },
  t: Texts = texts(),
): BlockVerdict {
  const block = findBlocks(text, check.fence).at(-1)
  if (!block) return { kind: 'absent' }
  if (!block.closed) {
    return {
      kind: 'invalid',
      block,
      issues: [{ path: ISSUE_UNCLOSED, message: t.blockUnclosed }],
    }
  }

  const raw = normalizeRaw(block.raw)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // the V8 message quotes a chunk of JSON with newlines — flatten it into one error line
    const message = t.jsonNotParsed(reason.replace(/\s+/g, ' ').slice(0, 200))
    return { kind: 'invalid', block, issues: [{ path: ISSUE_JSON, message }] }
  }

  if (check.validate(data)) return { kind: 'valid', block, raw }
  return { kind: 'invalid', block, issues: schemaIssues(check.validate.errors ?? [], check.validate.schema, t) }
}

/* ---------------------------------------------------- errors for the model */

/** `- path: message` without the marker, at most MAX_ISSUE_LINES lines. */
export function issueLines(issues: readonly Issue[], t: Texts = texts(), max = MAX_ISSUE_LINES): string[] {
  const lines = issues.map((i) => (SPECIAL_PATHS.has(i.path) ? i.message : `${i.path}: ${i.message}`))
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), t.andMore(lines.length - (max - 1))]
}

/** Short list of paths for SSE: no messages, no duplicates. */
export function issuePaths(issues: readonly Issue[], max = MAX_ISSUE_LINES): string[] {
  return [...new Set(issues.map((i) => i.path))].slice(0, max)
}

/** Synthetic user message of a repair step (SPEC §5.4), in the run locale (Appendix B). */
export function repairPrompt(fence: string, issues: readonly Issue[], t: Texts = texts()): string {
  return [t.checkHeader(fence), ...issueLines(issues, t).map((line) => `- ${line}`), t.checkFooter(fence)].join('\n')
}

type AnyError = ErrorObject & { synthetic?: true; hint?: string | null }

/**
 * Errors about the shape of an object — the ancestor's description adds meaning to them.
 * Value errors (pattern, enum, maximum…) are clear on their own: "weight ≤ 10" without
 * restating the rule.
 */
const STRUCTURAL_KEYWORDS = new Set([
  'required',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'additionalProperties',
  'dependentRequired',
  'not',
  'if',
  'oneOf',
  'anyOf',
])

/**
 * ajv errors → a short list for the model. allErrors on oneOf / anyOf reports the
 * errors of ALL branches — a model that gets "condition is required", "predicate is
 * required" and "predicates is required" at once is confused even more. Hence:
 * - oneOf / anyOf branches are collapsed into one: "exactly one field from the list"
 *   is named directly, branches of another type are dropped, of the rest the closest
 *   one is taken;
 * - umbrella errors (oneOf, anyOf, if, discriminator) with concrete errors behind
 *   them are removed;
 * - the line gets the description of the nearest described ancestor schema (except
 *   the root), once per message: the model understands "must have at most 1 item" in
 *   predicates only once it learns the rule is exactly one condition;
 * - deepest paths first.
 */
export function schemaIssues(errors: readonly ErrorObject[], rootSchema?: unknown, t: Texts = texts()): Issue[] {
  const own = errors.map((e) => ({ ...e })) as AnyError[]
  t.localizeAjv(own)
  let errs: AnyError[] = own
  const parents = parentMap(rootSchema)
  const hintFor = (schema: unknown): string | null => nearestDescription(schema, rootSchema, parents)

  const umbrellas = errs
    .filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf')
    .sort((a, b) => depth(b.instancePath) - depth(a.instancePath))
  for (const umbrella of umbrellas) {
    if (!errs.includes(umbrella)) continue
    const branches = Array.isArray(umbrella.schema) ? (umbrella.schema as unknown[]) : []
    const reach = branches.map(reachable)
    const groups: AnyError[][] = branches.map(() => [])
    for (const e of errs) {
      if (e === umbrella || !within(e.instancePath, umbrella.instancePath)) continue
      const index = reach.findIndex((set) => e.parentSchema != null && set.has(e.parentSchema))
      if (index >= 0) groups[index]!.push(e)
    }
    const replacement = resolveUmbrella(umbrella, branches, groups, hintFor(umbrella.parentSchema), t)
    const dropped = new Set<AnyError>([umbrella, ...groups.flat()])
    errs = [...errs.filter((e) => !dropped.has(e)), ...replacement]
  }

  const described: Array<Issue & { hint: string | null }> = []
  for (const e of errs) {
    const message = describeError(e, errs, t)
    if (message == null) continue
    const hint = e.synthetic ? (e.hint ?? null) : STRUCTURAL_KEYWORDS.has(e.keyword) ? hintFor(e.parentSchema) : null
    described.push({ path: e.instancePath || '/', message, hint })
  }

  const seen = new Set<string>()
  const unique = described.filter((i) => {
    const key = `${i.path}\u0000${i.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // most specific first — deeper in the document; sort is stable
  unique.sort((a, b) => depth(b.path === '/' ? '' : b.path) - depth(a.path === '/' ? '' : a.path))

  const hinted = new Set<string>()
  return unique.map(({ path, message, hint }) => {
    if (!hint || hinted.has(hint)) return { path, message }
    hinted.add(hint)
    return { path, message: `${message}. ${hint}` }
  })
}

function resolveUmbrella(
  umbrella: AnyError,
  branches: unknown[],
  groups: AnyError[][],
  hint: string | null,
  t: Texts,
): AnyError[] {
  const oneOf = umbrella.keyword === 'oneOf'
  const data = umbrella.data

  // the "exactly one / at least one field from the list" idiom: each branch requires one field of its own
  const keys = branches.map((b) =>
    isRecord(b) && Array.isArray(b.required) && b.required.length === 1 && typeof b.required[0] === 'string'
      ? (b.required[0] as string)
      : null,
  )
  if (isRecord(data) && keys.length > 1 && keys.every((k) => k != null) && new Set(keys).size === keys.length) {
    const names = keys as string[]
    const present = names.filter((k) => Object.prototype.hasOwnProperty.call(data, k))
    if (present.length === 0) {
      // for oneOf the first branch is the primary form: name it, the description says the rest
      const want = oneOf ? t.fieldRequired(quote(names[0]!)) : t.atLeastOneField(names.map(quote))
      // ".predicate" instead of "predicate": the key is mangled and ajv says nothing, since
      // the schema does not forbid extra fields. Name it, or the model won't see what is wrong
      const lookalikes = Object.keys(data).filter(
        (k) => !names.includes(k) && names.some((name) => normalizeKey(name) === normalizeKey(k)),
      )
      const parts = [want, ...lookalikes.map((k) => t.keyNotRecognized(quote(k)))]
      return [synthetic(umbrella.instancePath, parts.join('; '), hint)]
    }
    if (oneOf && present.length > 1) {
      return [
        synthetic(umbrella.instancePath, t.onlyOneField(names.map(quote), present.map(quote)), hint),
      ]
    }
    const kept = groups[names.indexOf(present[0]!)]!.filter((e) => !isExclusivityNot(e, umbrella))
    return kept.length > 0 ? kept : [synthetic(umbrella.instancePath, umbrellaMessage(oneOf, t), hint)]
  }

  // a branch without errors passed — so oneOf matched several: nothing concrete to say
  const failing = groups.map((g, i) => ({ i, g })).filter((x) => x.g.length > 0)
  if (failing.length < groups.length || failing.length === 0) {
    return [synthetic(umbrella.instancePath, umbrellaMessage(oneOf, t), hint)]
  }

  // a branch of another type (a string instead of a number) is beside the point
  const typeMismatch = (g: AnyError[]) => g.some((e) => e.keyword === 'type' && e.instancePath === umbrella.instancePath)
  const candidates = failing.filter((x) => !typeMismatch(x.g))
  if (candidates.length === 0) {
    const types = [
      ...new Set(
        failing.flatMap((x) =>
          x.g.filter((e) => e.keyword === 'type' && e.instancePath === umbrella.instancePath).map((e) => String(e.params.type)),
        ),
      ),
    ]
    return [synthetic(umbrella.instancePath, t.mustBeTypes(types), hint)]
  }

  candidates.sort((a, b) => a.g.length - b.g.length || a.i - b.i)
  const kept = candidates[0]!.g.filter((e) => !isExclusivityNot(e, umbrella))
  return kept.length > 0 ? kept : [synthetic(umbrella.instancePath, umbrellaMessage(oneOf, t), hint)]
}

/**
 * `not` on the branch object itself means "the other field must not be present": the
 * oneOf line already says that. A deeper `not` (`min: { not: { type: null } }`) is
 * concrete, so it is kept.
 */
function isExclusivityNot(e: AnyError, umbrella: AnyError): boolean {
  return e.keyword === 'not' && e.instancePath === umbrella.instancePath
}

/** Text of the error line; null — the error is not shown (an umbrella over concrete ones). */
function describeError(e: AnyError, all: readonly AnyError[], t: Texts): string | null {
  if (e.synthetic) return e.message ?? ''
  const params = e.params as Record<string, unknown>
  switch (e.keyword) {
    case 'if':
      // "must match "then" schema" — dropped if the then error itself is present
      return all.some((o) => o !== e && within(o.instancePath, e.instancePath)) ? null : (e.message ?? '')
    case 'discriminator': {
      const tag = String(params.tag ?? '')
      if (params.error === 'mapping') {
        // the enum on the tag field itself already said the same, with the list of values
        if (all.some((o) => o.instancePath === `${e.instancePath}/${tag}`)) return null
        return t.tagInvalidValue(quote(tag), JSON.stringify(params.tagValue))
      }
      return e.message ?? ''
    }
    case 'enum':
      return `${e.message}: ${(params.allowedValues as unknown[] | undefined)?.map((v) => JSON.stringify(v)).join(', ') ?? ''}`
    case 'const':
      return `${e.message}: ${JSON.stringify(params.allowedValue)}`
    case 'additionalProperties':
      return `${e.message}: ${quote(String(params.additionalProperty))}`
    case 'not': {
      // { not: { type: "null" } } is a common case, and "must NOT be valid" tells the model nothing
      const schema = e.schema
      if (isRecord(schema) && Object.keys(schema).length === 1 && typeof schema.type === 'string') {
        return t.cannotBe(schema.type)
      }
      return e.message ?? ''
    }
    case 'oneOf':
    case 'anyOf':
      return umbrellaMessage(e.keyword === 'oneOf', t)
    default:
      return e.message ?? ''
  }
}

function synthetic(instancePath: string, message: string, hint: string | null): AnyError {
  return { instancePath, schemaPath: '', keyword: 'synthetic', params: {}, message, synthetic: true, hint }
}

function umbrellaMessage(oneOf: boolean, t: Texts): string {
  return oneOf ? t.oneOfMismatch : t.anyOfMismatch
}

function schemaDescription(schema: unknown): string | null {
  return isRecord(schema) && typeof schema.description === 'string' && schema.description.trim()
    ? schema.description.trim()
    : null
}

/** child → parent across the whole schema document ($defs inside the root, no $ref needed). */
const parentCache = new WeakMap<object, WeakMap<object, object>>()
function parentMap(root: unknown): WeakMap<object, object> {
  if (typeof root !== 'object' || root === null) return new WeakMap()
  const hit = parentCache.get(root)
  if (hit) return hit
  const parents = new WeakMap<object, object>()
  const stack: object[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    for (const value of Object.values(node)) {
      if (typeof value !== 'object' || value === null || parents.has(value) || value === root) continue
      parents.set(value, node)
      stack.push(value)
    }
  }
  parentCache.set(root, parents)
  return parents
}

/**
 * description of the schema itself or of the nearest described ancestor. The root is
 * skipped: its description is documentation for humans, not a hint for the model.
 */
function nearestDescription(schema: unknown, root: unknown, parents: WeakMap<object, object>): string | null {
  let node: unknown = schema
  for (let hops = 0; typeof node === 'object' && node !== null && node !== root && hops < 16; hops++) {
    const description = schemaDescription(node)
    if (description) return description
    node = parents.get(node)
  }
  return null
}

/** All objects and arrays of a schema branch — without following $ref (ajv paths start over there). */
const reachCache = new WeakMap<object, Set<unknown>>()
function reachable(root: unknown): Set<unknown> {
  if (typeof root !== 'object' || root === null) return new Set()
  const hit = reachCache.get(root)
  if (hit) return hit
  const out = new Set<unknown>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null || out.has(node)) continue
    out.add(node)
    for (const value of Object.values(node)) stack.push(value)
  }
  reachCache.set(root, out)
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function within(path: string, base: string): boolean {
  return base === '' || path === base || path.startsWith(`${base}/`)
}

function depth(path: string): number {
  return path === '' ? 0 : path.split('/').length - 1
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function quote(value: string): string {
  return JSON.stringify(value)
}
