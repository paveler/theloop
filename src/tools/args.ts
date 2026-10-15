/**
 * Tool-call arguments checked against input_schema (SPEC §6.1, §6.4).
 *
 * With a `jsonSchema()` schema and no validator the AI SDK does NOT check arguments:
 * `{}` passes with `required: ["sum"]` and goes off to the write endpoint.
 * For a write tool that means an operation with missing fields, so we check
 * ourselves — but conservatively: we reject only what we are sure about (type,
 * required, enum). On unknown keywords (anyOf, $ref, patternProperties…) the whole
 * node is skipped, so a valid call is never rejected.
 */
import { texts, type Texts } from '../i18n.js'

export type ArgsVerdict = { ok: true } | { ok: false; reason: string }

const UNSUPPORTED = ['anyOf', 'oneOf', 'allOf', 'not', '$ref', 'patternProperties', 'if', 'dependentSchemas']

/** The reason is in the run locale (SPEC Appendix B): the model reads it in invalid_tool_input. */
export function validateToolArgs(schema: unknown, args: unknown, t: Texts = texts()): ArgsVerdict {
  const problem = check(schema, args, '', t)
  return problem ? { ok: false, reason: problem } : { ok: true }
}

function check(schema: unknown, value: unknown, path: string, t: Texts): string | null {
  if (!isObject(schema)) return null
  if (UNSUPPORTED.some((key) => key in schema)) return null // not our node — no verdict

  const where = path || t.argsRoot

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    return t.argNotInEnum(where)
  }

  const type = schema.type
  if (typeof type === 'string' && !matchesType(type, value)) {
    return t.argWrongType(where, type, describe(value))
  }
  if (Array.isArray(type) && !type.some((option) => typeof option === 'string' && matchesType(option, value))) {
    return t.argWrongTypeOneOf(where, type, describe(value))
  }

  if (type === 'object' || (type == null && isObject(schema.properties))) {
    if (!isObject(value)) return null // type not declared explicitly — do not nitpick
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key !== 'string') continue
      if (!(key in value) || value[key] === undefined) {
        return t.argMissingField(where, key)
      }
    }
    const properties = isObject(schema.properties) ? schema.properties : {}
    for (const [key, sub] of Object.entries(properties)) {
      if (!(key in value)) continue
      const problem = check(sub, value[key], path ? `${path}.${key}` : key, t)
      if (problem) return problem
    }
    return null
  }

  if (type === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return t.argMinItems(where, schema.minItems)
    }
    if (isObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const problem = check(schema.items, value[i], `${where}[${i}]`, t)
        if (problem) return problem
      }
    }
  }

  return null
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true // unknown type — no verdict
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}
