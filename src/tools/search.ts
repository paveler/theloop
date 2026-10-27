/**
 * The engine's tool search (SPEC §6.8, `search_tools`): BM25 over deferred tools. The same
 * code on every provider, so the model sees the same tool everywhere and the result is
 * reproducible from the request.
 */

/** BM25 parameters (RFC 0001, 5.4). */
const K1 = 1.2
const B = 0.75

export const SEARCH_QUERY_MAX_CHARS = 500
export const SEARCH_LIMIT_DEFAULT = 5
export const SEARCH_LIMIT_MAX = 20

export interface SearchableTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** Splits an identifier on `_`, `-` and camelCase: `createReturn_v2` → `create Return v2`. */
function splitIdentifier(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
}

/**
 * Lower-cased runs of Unicode letters and digits, at least two characters. No stemming, no
 * stop words: the search is language-neutral.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match[0].length >= 2) out.push(match[0])
  }
  return out
}

/** Property names (split like the tool name) and descriptions of a JSON Schema, nested ones too. */
function schemaText(schema: unknown, out: string[], depth = 0): void {
  if (depth > 8 || schema === null || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  if (typeof node.description === 'string' && depth > 0) out.push(node.description)
  const properties = node.properties
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      out.push(splitIdentifier(key))
      schemaText(value, out, depth + 1)
    }
  }
  if (node.items) schemaText(node.items, out, depth + 1)
}

function documentTokens(tool: SearchableTool): string[] {
  const parts = [splitIdentifier(tool.name), tool.description ?? '']
  schemaText(tool.input_schema, parts)
  return tokenize(parts.join(' '))
}

/**
 * Tools with a positive score, best first, ties broken by name, at most `limit`
 * (default 5, cap 20). The query is cut to 500 characters.
 */
export function searchTools(tools: readonly SearchableTool[], query: string, limit = SEARCH_LIMIT_DEFAULT): string[] {
  const cap = Math.min(Math.max(1, Math.trunc(limit)), SEARCH_LIMIT_MAX)
  const terms = [...new Set(tokenize(query.slice(0, SEARCH_QUERY_MAX_CHARS)))]
  if (terms.length === 0 || tools.length === 0) return []

  const docs = tools.map((tool) => {
    const tokens = documentTokens(tool)
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return { name: tool.name, length: tokens.length, tf }
  })
  const avgLength = docs.reduce((acc, d) => acc + d.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const term of terms) df.set(term, docs.filter((d) => d.tf.has(term)).length)

  const scored = docs
    .map((doc) => {
      let score = 0
      for (const term of terms) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const n = df.get(term)!
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength))
      }
      return { name: doc.name, score }
    })
    .filter((d) => d.score > 0)
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return scored.slice(0, cap).map((d) => d.name)
}
