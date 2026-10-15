/**
 * GigaChat (SPEC §9.1): api_key is the "authorization key" (Basic) from the developer
 * console; the engine obtains the OAuth token itself (≈30 min), caches it per key + scope
 * and refreshes it a minute before expiry. Parallel runs on a cold cache share one OAuth
 * request (single-flight): Sber's endpoint is rate-limited. A 401 from the API means the
 * token was revoked early: the cache is reset and the request is repeated once.
 * TLS: the Russian Trusted Root CA goes into the image + NODE_EXTRA_CA_CERTS;
 * rejectUnauthorized: false is forbidden.
 *
 * RqUID is mandatory (UUID4). Sber returns expires_at in Unix MILLIseconds, but some
 * descriptions say seconds, so both are normalized instead of guessing.
 */
import { randomUUID } from 'node:crypto'
import { sha256 } from '../ids.js'
import { log } from '../log.js'
import {
  collectImageUrls,
  fromGigachatPayload,
  toGigachatRequest,
  translateGigachatSse,
} from './gigachat-translate.js'

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
const OAUTH_TIMEOUT_MS = 15_000
const REFRESH_MARGIN_MS = 60_000

interface TokenCacheEntry {
  accessToken: string
  expiresAtMs: number
}

const cache = new Map<string, TokenCacheEntry>()
const inflight = new Map<string, Promise<TokenCacheEntry>>()

export function resetGigachatTokenCache(): void {
  cache.clear()
  inflight.clear()
}

function cacheKeyFor(authKey: string, scope: string): string {
  return sha256(`${authKey}|${scope}`)
}

export async function gigachatAccessToken(
  authKey: string,
  scope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = cacheKeyFor(authKey, scope)
  const hit = cache.get(cacheKey)
  if (hit && hit.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) return hit.accessToken

  let pending = inflight.get(cacheKey)
  if (!pending) {
    pending = requestToken(authKey, scope, fetchImpl)
      .then((entry) => {
        cache.set(cacheKey, entry)
        return entry
      })
      .finally(() => {
        // errors are not cached: the next call fetches a token again
        if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey)
      })
    inflight.set(cacheKey, pending)
  }
  return (await pending).accessToken
}

/** Drops the token after a 401, but only if the cache still holds that same token. */
function invalidateToken(authKey: string, scope: string, token: string): void {
  const cacheKey = cacheKeyFor(authKey, scope)
  if (cache.get(cacheKey)?.accessToken === token) cache.delete(cacheKey)
}

/**
 * Sber OAuth refusal. 400 / 401 / 403: the key is broken or does not match the scope
 * (PERS / B2B / CORP); repeating is pointless, the attempt is failed / provider_auth.
 * Everything else (429, 5xx) is transient and retried as usual.
 */
export class GigachatOAuthError extends Error {
  readonly permanent: boolean
  constructor(
    readonly status: number,
    readonly scope: string,
    readonly responseBody: string,
  ) {
    super(`GigaChat OAuth: HTTP ${status} (scope ${scope})${responseBody ? ` — ${responseBody}` : ''}`)
    this.name = 'GigachatOAuthError'
    this.permanent = status === 400 || status === 401 || status === 403
  }
}

async function requestToken(
  authKey: string,
  scope: string,
  fetchImpl: typeof fetch,
): Promise<TokenCacheEntry> {
  let res: Response
  try {
    res = await fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope }).toString(),
      // the request is shared by several runs, so it is not tied to one run's abort signal
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
  } catch (err) {
    // the most common cause: the image lacks the Russian Trusted Root CA (certs/README.md).
    // Without an explicit explanation this looks like "the network dropped".
    if (isCertificateError(err)) {
      throw new Error(
        'GigaChat OAuth: TLS rejected the certificate chain. The image lacks the Russian Trusted Root CA: ' +
          'put certs/*.crt in place and set NODE_EXTRA_CA_CERTS (see certs/README.md). ' +
          'rejectUnauthorized: false is forbidden.',
      )
    }
    throw err
  }
  if (!res.ok) {
    // the refusal reason is in Sber's response body ("scope from db not fully includes…",
    // "Can't decode 'Authorization' header"); without it a 400 cannot be diagnosed
    const body = (await res.text().catch(() => '')).slice(0, 512)
    throw new GigachatOAuthError(res.status, scope, body)
  }
  const json = (await res.json()) as { access_token?: unknown; expires_at?: unknown }
  if (typeof json.access_token !== 'string' || !json.access_token || typeof json.expires_at !== 'number') {
    throw new Error('GigaChat OAuth: no access_token / expires_at in the response')
  }
  return {
    accessToken: json.access_token,
    // seconds → ms; a value already in ms (> 1e11) is kept as is
    expiresAtMs: json.expires_at > 1e11 ? json.expires_at : json.expires_at * 1000,
  }
}

const CERT_ERRORS =
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_UNTRUSTED|unable to verify the first certificate|DEPTH_ZERO_SELF_SIGNED_CERT/i

export function isCertificateError(err: unknown): boolean {
  const parts = [
    (err as { code?: string })?.code,
    (err as { cause?: { code?: string } })?.cause?.code,
    err instanceof Error ? err.message : String(err),
    (err as { cause?: { message?: string } })?.cause?.message,
  ].filter(Boolean)
  return parts.some((p) => CERT_ERRORS.test(String(p)))
}

/** A request to the GigaChat API with a fresh Bearer. */
type AuthorizedFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

export interface GigachatTransport {
  /** fetch for the AI SDK: Bearer, chat/completions translation, image upload. */
  fetch: typeof fetch
  /** End of run: delete the files uploaded during the run (SPEC §5.3). Never throws. */
  release: (runId: string) => Promise<void>
}

const CHAT_SUFFIX = '/chat/completions'

/**
 * Transport for one run. Sets a fresh Bearer before every request to
 * GigaChat and translates chat/completions between the OpenAI dialect and the GigaChat format
 * (tools ↔ functions, images → attachments, see gigachat-translate.ts).
 * 401 → the token was revoked early: reset the cache and repeat once with a new token.
 * The repeat is safe: a 401 arrives before generation, there is no content yet.
 */
export function gigachatTransport(authKey: string, scope: string, baseFetch: typeof fetch): GigachatTransport {
  const authorized: AuthorizedFetch = async (input, init) => {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return baseFetch(input, { ...init, headers })
    }

    const token = await gigachatAccessToken(authKey, scope, baseFetch)
    const res = await send(token)
    const body = init?.body
    const replayable = body == null || typeof body === 'string' || body instanceof Uint8Array
    if (res.status !== 401 || !replayable) return res
    await res.body?.cancel().catch(() => {})
    invalidateToken(authKey, scope, token)
    return send(await gigachatAccessToken(authKey, scope, baseFetch))
  }

  const files = new RunFiles(authorized)

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.endsWith(CHAT_SUFFIX) || typeof init?.body !== 'string') return authorized(input, init)

    let request: Record<string, unknown>
    try {
      request = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      return authorized(input, init)
    }

    const filesUrl = url.slice(0, -CHAT_SUFFIX.length) + '/files'
    const attachments = await files.upload(collectImageUrls(request), filesUrl, init.signal ?? undefined)
    // an upload refusal becomes this call's response: the AI SDK turns it into a provider error
    if (attachments instanceof Response) return attachments

    const body = JSON.stringify(toGigachatRequest(request, attachments))
    const res = await authorized(input, { ...init, body })
    return res.ok ? translateResponse(res) : res
  }

  return { fetch: fetchImpl, release: (runId) => files.release(runId) }
}

/** fetch without file cleanup, for translator and OAuth tests. */
export function gigachatFetch(authKey: string, scope: string, baseFetch: typeof fetch): typeof fetch {
  return gigachatTransport(authKey, scope, baseFetch).fetch
}

const DELETE_TIMEOUT_MS = 10_000

/** Sber refused the upload: status and body are passed on as the call's response. */
class UploadRejected extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly contentType: string,
  ) {
    super(`GigaChat /files: HTTP ${status}`)
  }

  toResponse(): Response {
    return new Response(this.body, { status: this.status, headers: { 'content-type': this.contentType } })
  }
}

/**
 * The run's images in GigaChat storage (SPEC §5.3). GigaChat accepts an image only as a
 * file: POST /files (multipart, purpose=general) → id in attachments. Each image is
 * uploaded once per run: loop steps reuse the id, so GigaChat's cache (which is
 * tied to the file id) works within the run. The files are deleted at the end of the run.
 */
class RunFiles {
  /** sha256(data URL) → file id. A failed upload is removed from the cache. */
  private readonly uploads = new Map<string, Promise<string>>()
  private filesUrl: string | null = null

  constructor(private readonly authorized: AuthorizedFetch) {}

  async upload(
    urls: string[],
    filesUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, string> | Response> {
    const ids = new Map<string, string>()
    if (urls.length === 0) return ids
    this.filesUrl = filesUrl
    try {
      await Promise.all(urls.map(async (url) => ids.set(url, await this.uploadOne(url, filesUrl, signal))))
    } catch (err) {
      if (err instanceof UploadRejected) return err.toResponse()
      throw err
    }
    return ids
  }

  private uploadOne(dataUrl: string, filesUrl: string, signal: AbortSignal | undefined): Promise<string> {
    const key = sha256(dataUrl)
    const hit = this.uploads.get(key)
    if (hit) return hit
    const task = this.send(dataUrl, filesUrl, signal)
    task.catch(() => {
      if (this.uploads.get(key) === task) this.uploads.delete(key)
    })
    this.uploads.set(key, task)
    return task
  }

  private async send(dataUrl: string, filesUrl: string, signal: AbortSignal | undefined): Promise<string> {
    const form = multipartImage(dataUrl)
    const res = await this.authorized(filesUrl, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
      signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new UploadRejected(res.status, body, res.headers.get('content-type') ?? 'application/json')
    }
    const json = (await res.json()) as { id?: unknown }
    if (typeof json.id !== 'string' || !json.id) throw new Error('GigaChat /files: no id in the response')
    return json.id
  }

  async release(runId: string): Promise<void> {
    if (this.uploads.size === 0 || !this.filesUrl) return
    const filesUrl = this.filesUrl
    try {
      const settled = await Promise.allSettled([...this.uploads.values()])
      this.uploads.clear()
      const ids = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
      if (ids.length === 0) return

      const results = await Promise.allSettled(ids.map((id) => this.remove(filesUrl, id)))
      const failed = results.flatMap((r, i) =>
        r.status === 'rejected' ? [{ file_id: ids[i], error: String(r.reason) }] : [],
      )
      const fields = { run_id: runId, files: ids.length, failed: failed.length }
      if (failed.length > 0) log.warn('gigachat_files_deleted', { ...fields, errors: failed })
      else log.info('gigachat_files_deleted', fields)
    } catch (err) {
      log.warn('gigachat_files_deleted', { run_id: runId, error: String(err) })
    }
  }

  private async remove(filesUrl: string, id: string): Promise<void> {
    const res = await this.authorized(`${filesUrl}/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => {})
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }
}

/** data URL from the AI SDK → multipart for POST /files. Built by hand: undici and Node have different FormData classes. */
function multipartImage(dataUrl: string): { body: Uint8Array; contentType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('GigaChat: the image is not a base64 data URL')
  const mediaType = match[1]!
  const filename = `image.${mediaType.split('/')[1] ?? 'bin'}`
  const boundary = `theloop-${randomUUID()}`
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`
  const body = Buffer.concat([
    Buffer.from(head),
    Buffer.from(match[2]!, 'base64'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body: new Uint8Array(body), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function translateResponse(res: Response): Promise<Response> {
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  const init = { status: res.status, statusText: res.statusText, headers }

  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return new Response(res.body ? translateGigachatSse(res.body) : null, init)
  }
  const text = await res.text()
  try {
    return new Response(JSON.stringify(fromGigachatPayload(JSON.parse(text) as Record<string, unknown>)), init)
  } catch {
    return new Response(text, init)
  }
}
