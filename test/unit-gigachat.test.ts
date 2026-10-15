import { beforeEach, describe, expect, it } from 'vitest'
import { LlmSchema } from '../src/contracts.js'
import {
  GigachatOAuthError,
  gigachatAccessToken,
  gigachatFetch,
  resetGigachatTokenCache,
} from '../src/providers/gigachat.js'
import { classifyProviderError } from '../src/runs/provider.js'

const OAUTH_HOST = 'ngw.devices.sberbank.ru'
const API_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions'

interface Call {
  url: string
  headers: Headers
  body: unknown
}

/** Mock fetch: OAuth hands out tokens in order, the API hands out responses in order. */
function mockFetch(opts: {
  tokens?: Array<{ access_token: string; expires_at: number } | { status: number }>
  api?: Array<{ status: number; body?: string }>
  oauthDelayMs?: number
}) {
  const calls: Call[] = []
  const tokens = [...(opts.tokens ?? [])]
  const api = [...(opts.api ?? [])]
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body })
    if (url.includes(OAUTH_HOST)) {
      if (opts.oauthDelayMs) await new Promise((r) => setTimeout(r, opts.oauthDelayMs))
      const next = tokens.shift()
      if (!next) throw new Error('mock: out of tokens')
      if ('status' in next) return new Response('denied', { status: next.status })
      return Response.json(next)
    }
    const next = api.shift() ?? { status: 200, body: '{}' }
    return new Response(next.body ?? '{}', { status: next.status })
  }
  const oauthCalls = () => calls.filter((c) => c.url.includes(OAUTH_HOST))
  const apiCalls = () => calls.filter((c) => !c.url.includes(OAUTH_HOST))
  return { impl, calls, oauthCalls, apiCalls }
}

const inHalfHourMs = () => Date.now() + 30 * 60_000

beforeEach(() => resetGigachatTokenCache())

describe('GigaChat OAuth (SPEC §9.1)', () => {
  it('token request: Basic, RqUID (UUID4), scope in the form body', async () => {
    const m = mockFetch({ tokens: [{ access_token: 't1', expires_at: inHalfHourMs() }] })
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_B2B', m.impl)).toBe('t1')

    const [call] = m.oauthCalls()
    expect(call!.headers.get('authorization')).toBe('Basic KEY')
    expect(call!.headers.get('rquid')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(call!.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(call!.body).toBe('scope=GIGACHAT_API_B2B')
  })

  it('the token is cached: the second call skips OAuth', async () => {
    const m = mockFetch({ tokens: [{ access_token: 't1', expires_at: inHalfHourMs() }] })
    await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)).toBe('t1')
    expect(m.oauthCalls()).toHaveLength(1)
  })

  it('expires_at in seconds and in milliseconds normalize the same way', async () => {
    const m = mockFetch({
      tokens: [
        { access_token: 'sec', expires_at: Math.floor(inHalfHourMs() / 1000) },
        { access_token: 'ms', expires_at: inHalfHourMs() },
      ],
    })
    await gigachatAccessToken('K1', 'GIGACHAT_API_PERS', m.impl)
    await gigachatAccessToken('K2', 'GIGACHAT_API_PERS', m.impl)
    // both are live, so repeat calls come from the cache
    expect(await gigachatAccessToken('K1', 'GIGACHAT_API_PERS', m.impl)).toBe('sec')
    expect(await gigachatAccessToken('K2', 'GIGACHAT_API_PERS', m.impl)).toBe('ms')
    expect(m.oauthCalls()).toHaveLength(2)
  })

  it('refreshes a minute before expiry', async () => {
    const m = mockFetch({
      tokens: [
        { access_token: 'old', expires_at: Date.now() + 30_000 },
        { access_token: 'new', expires_at: inHalfHourMs() },
      ],
    })
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)).toBe('old')
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)).toBe('new')
    expect(m.oauthCalls()).toHaveLength(2)
  })

  it('the cache is separate per scope and per key', async () => {
    const m = mockFetch({
      tokens: [
        { access_token: 'pers', expires_at: inHalfHourMs() },
        { access_token: 'corp', expires_at: inHalfHourMs() },
      ],
    })
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)).toBe('pers')
    expect(await gigachatAccessToken('KEY', 'GIGACHAT_API_CORP', m.impl)).toBe('corp')
    expect(m.oauthCalls()).toHaveLength(2)
  })

  it('single-flight: parallel calls on a cold cache make one OAuth request', async () => {
    const m = mockFetch({
      tokens: [{ access_token: 't1', expires_at: inHalfHourMs() }],
      oauthDelayMs: 20,
    })
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)),
    )
    expect(new Set(tokens)).toEqual(new Set(['t1']))
    expect(m.oauthCalls()).toHaveLength(1)
  })

  it('an OAuth error is not cached and its text has no key', async () => {
    const m = mockFetch({
      tokens: [{ status: 401 }, { access_token: 't1', expires_at: inHalfHourMs() }],
    })
    const err = await gigachatAccessToken('SECRET-KEY', 'GIGACHAT_API_PERS', m.impl).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('GIGACHAT_API_PERS')
    expect(err.message).not.toContain('SECRET-KEY')
    expect(await gigachatAccessToken('SECRET-KEY', 'GIGACHAT_API_PERS', m.impl)).toBe('t1')
  })

  it('OAuth 400 / 401: provider_auth without retry, the OAuth response body in the error', async () => {
    const impl: typeof fetch = async () =>
      new Response('{"code":7,"message":"scope from db not fully includes consumed scope"}', { status: 400 })
    const err = await gigachatAccessToken('SECRET-KEY', 'GIGACHAT_API_PERS', impl).catch((e) => e)
    expect(err).toBeInstanceOf(GigachatOAuthError)
    expect(err.message).toContain('scope from db')

    // the SDK may wrap the fetch error, so the classifier looks into cause too
    const failure = classifyProviderError(new Error('wrapped', { cause: err }))
    expect(failure).toMatchObject({ kind: 'failed', code: 'provider_auth', retriable: false, providerStatus: 400 })
    expect(failure.providerBody).toContain('scope from db')
    expect(JSON.stringify(failure)).not.toContain('SECRET-KEY')
  })

  it('OAuth 5xx stays a transient error and is retried', async () => {
    const impl: typeof fetch = async () => new Response('bad gateway', { status: 502 })
    const err = await gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', impl).catch((e) => e)
    expect(classifyProviderError(err)).toMatchObject({ kind: 'unknown', retriable: true })
  })

  it('a response without access_token is an error, not Bearer undefined', async () => {
    const m = mockFetch({ tokens: [{ expires_at: inHalfHourMs() } as never] })
    await expect(gigachatAccessToken('KEY', 'GIGACHAT_API_PERS', m.impl)).rejects.toThrow(
      /access_token/,
    )
  })
})

describe('gigachatFetch', () => {
  it('sets Bearer and does not send the authorization key to the API', async () => {
    const m = mockFetch({ tokens: [{ access_token: 't1', expires_at: inHalfHourMs() }] })
    const f = gigachatFetch('KEY', 'GIGACHAT_API_PERS', m.impl)
    const res = await f(API_URL, { method: 'POST', body: '{"a":1}' })
    expect(res.status).toBe(200)
    const [call] = m.apiCalls()
    expect(call!.headers.get('authorization')).toBe('Bearer t1')
    expect(call!.body).toBe('{"a":1}')
  })

  it('401 from the API: drops the token and retries once with a new one', async () => {
    const m = mockFetch({
      tokens: [
        { access_token: 'revoked', expires_at: inHalfHourMs() },
        { access_token: 'fresh', expires_at: inHalfHourMs() },
      ],
      api: [{ status: 401 }, { status: 200, body: '{"ok":true}' }],
    })
    const f = gigachatFetch('KEY', 'GIGACHAT_API_PERS', m.impl)
    const res = await f(API_URL, { method: 'POST', body: '{"a":1}' })
    expect(res.status).toBe(200)
    expect(m.apiCalls().map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer revoked',
      'Bearer fresh',
    ])
    expect(m.apiCalls()[1]!.body).toBe('{"a":1}')
    expect(m.oauthCalls()).toHaveLength(2)
  })

  it('a second 401 is returned as is, no loop', async () => {
    const m = mockFetch({
      tokens: [
        { access_token: 'a', expires_at: inHalfHourMs() },
        { access_token: 'b', expires_at: inHalfHourMs() },
      ],
      api: [{ status: 401 }, { status: 401 }],
    })
    const f = gigachatFetch('KEY', 'GIGACHAT_API_PERS', m.impl)
    const res = await f(API_URL, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(m.apiCalls()).toHaveLength(2)
  })
})

describe('llm.gigachat_scope (SPEC §4.2)', () => {
  const base = { provider: 'gigachat', model: 'GigaChat-2-Max' }

  it('the field is optional and accepts the three GigaChat scopes', () => {
    expect(LlmSchema.parse(base).gigachat_scope).toBeUndefined()
    expect(LlmSchema.parse({ ...base, gigachat_scope: 'GIGACHAT_API_CORP' }).gigachat_scope).toBe(
      'GIGACHAT_API_CORP',
    )
  })

  it('an arbitrary string is rejected', () => {
    expect(LlmSchema.safeParse({ ...base, gigachat_scope: 'ADMIN' }).success).toBe(false)
  })
})
