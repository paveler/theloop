/** Identifiers and tokens. The run token is 32 random bytes (SPEC §4.1). */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, as in ULID

function suffix(len = 16): string {
  const buf = randomBytes(len)
  let out = ''
  for (const b of buf) out += ALPHABET[b % 32]
  return out
}

export function newRunId(): string {
  return `run_${Date.now().toString(36).toUpperCase()}${suffix(12)}`
}

export function newCallId(): string {
  return `call_${suffix(16)}`
}

/** 32 random bytes in base64url — the run token and per-call tokens (SPEC §4.1, §6.2). */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Request body hash — for idempotency_mismatch and duplicate tool-results (SPEC §4.2, §4.5). */
export function hashBody(value: unknown): string {
  return sha256(stableStringify(value))
}

/** Deterministic serialization: key order must not affect the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** Constant-time secret comparison (tokens): digests have a fixed length, so nothing leaks the secret's length. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}
