/**
 * One HTTP client for tools, the callback, images and openai-compatible
 * (SPEC §11.4): https only, host from EGRESS_ALLOWLIST, private IPs forbidden,
 * redirects never followed, headers only Authorization and X-*, body limit per
 * purpose.
 *
 * DNS pinning: the address is resolved by our lookup inside the undici agent, and the
 * connection goes exactly to the checked address, so DNS rebinding between the check
 * and the connect is impossible.
 *
 * A provider with <PROVIDER>_PROXY_URL goes through its own ProxyAgent (CONNECT /
 * SOCKS5): TLS to the provider is end-to-end, the proxy never sees the key. The proxy
 * resolves the target address, so there is no pinning there: named providers have
 * built-in base_urls, and the proxy itself is set by the operator.
 */
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { Config } from '../config.js'
import type { ProviderId } from '../contracts.js'
import { EngineError } from '../errors.js'
import { log, safeUrl } from '../log.js'
import { isLocalHostname } from './ip.js'
import { addressAllowed, parseAddr, type Cidr } from './cidr.js'
import { countEgressDenied } from '../metrics.js'

/** X-* headers the engine never lets out, although the X- prefix is otherwise allowed (SPEC §11.4). */
const HEADER_DENY = [/^x-forwarded-/i, /^x-original-/i, /^x-real-ip$/i, /^x-http-method-override$/i]

export function filterEgressHeaders(
  headers: Record<string, string> | undefined,
  onDrop?: (name: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.trim()
    const lower = name.toLowerCase()
    const allowed = lower === 'authorization' || lower.startsWith('x-')
    const denied = HEADER_DENY.some((re) => re.test(lower))
    if (!allowed || denied) {
      onDrop?.(name)
      continue
    }
    out[name] = value
  }
  return out
}

interface HostEntry {
  host: string
  port: number | null
}

/** `host`, `.suffix`, `host:port`, `[v6]`, `[v6]:port`; a bare IPv6 literal has no port. */
export function parseHostEntry(raw: string): HostEntry {
  const entry = raw.trim().toLowerCase()
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
  if (bracket) return { host: bracket[1]!, port: bracket[2] ? Number(bracket[2]) : null }
  const colons = entry.split(':').length - 1
  if (colons === 1) {
    const [host = '', port = ''] = entry.split(':')
    if (/^\d+$/.test(port)) return { host, port: Number(port) }
  }
  return { host: entry, port: null }
}

/**
 * `host` is an exact match, `.suffix` matches subdomains (SPEC §11.4); with `:port` only that
 * port matches. A caller that passes no port matches only entries without one.
 */
export function hostMatchesAllowlist(hostname: string, allowlist: readonly string[], port?: number): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of allowlist) {
    if (!raw.trim()) continue
    const entry = parseHostEntry(raw)
    if (entry.port != null && entry.port !== port) continue
    if (entry.host.startsWith('.')) {
      if (host.endsWith(entry.host)) return true
      if (host === entry.host.slice(1)) return true
    } else if (host === entry.host) {
      return true
    }
  }
  return false
}

export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}

/** `tool:<name>` and the like → the finite set metrics see (SPEC §4.10). */
export function purposeCategory(what: string): string {
  const head = what.split(':')[0]!.split('.')[0]!
  if (head === 'tool' || head === 'callback' || head === 'image' || head === 'error_webhook') return head
  return 'provider'
}

export interface EgressRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
  /** For the log: tool / callback / image. */
  purpose: string
}

export interface EgressResponse {
  status: number
  headers: Record<string, string>
  /** Body as text; never truncated: exceeding the limit is an error. */
  text: string
  bytes: Uint8Array
}

export type EgressDenyReason = 'not_allowlisted' | 'private_ip' | 'scheme' | 'userinfo' | 'invalid_url'

export class EgressDeniedError extends EngineError {
  constructor(message: string, details: Record<string, unknown> = {}, reason: EgressDenyReason = 'not_allowlisted') {
    super('egress_denied', message, details)
    countEgressDenied(purposeCategory(String(details.target ?? 'provider')), reason)
  }
}

export class EgressClient {
  private readonly agent: Dispatcher
  private readonly proxies = new Map<ProviderId, Dispatcher>()
  private readonly allowlist: string[]
  private readonly extraHosts = new Set<string>()
  /** Origins of base URL overrides and endpoints: allowed for the provider purpose only (SPEC §11.4). */
  private readonly providerOrigins = new Set<string>()
  private readonly plaintextSeen = new Set<string>()
  private readonly cidrs: readonly Cidr[]
  private readonly httpHosts: readonly string[]

  constructor(private readonly config: Config) {
    this.allowlist = config.egressAllowlist
    this.cidrs = config.egressPrivateCidrs ?? []
    this.httpHosts = config.egressHttpHosts ?? []
    for (const [provider, uri] of Object.entries(config.providerProxies) as Array<[ProviderId, string]>) {
      this.proxies.set(provider, new ProxyAgent({ uri, headersTimeout: 60_000, bodyTimeout: 300_000 }))
    }
    this.agent = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...(options as object), all: true, verbatim: true }, (err, addresses) => {
            const cb = callback as unknown as (
              err: NodeJS.ErrnoException | null,
              address?: unknown,
              family?: number,
            ) => void
            if (err) return cb(err)
            const list = addresses as Array<{ address: string; family: number }>
            const allowLocal = this.config.allowInsecureEgress && isLocalHostname(hostname)
            const safe = allowLocal ? list : list.filter((a) => this.addressAllowed(a.address, a.family))
            if (safe.length === 0) {
              return cb(
                Object.assign(new Error(`egress: private address for ${hostname}`), {
                  code: 'EGRESS_PRIVATE_IP',
                }),
              )
            }
            if ((options as { all?: boolean }).all) return cb(null, safe)
            const first = safe[0]!
            return cb(null, first.address, first.family)
          })
        },
      },
      headersTimeout: 60_000,
      bodyTimeout: 300_000,
    })
  }

  /** Allow a specific host (built-in provider base_urls are always allowed, SPEC §11.4). */
  allowHost(hostname: string): void {
    this.extraHosts.add(hostname.toLowerCase())
  }

  /** An override / endpoint origin (scheme, host, port): the provider purpose only (SPEC §11.4). */
  allowProviderOrigin(rawUrl: string): void {
    this.providerOrigins.add(new URL(rawUrl).origin)
  }

  /**
   * A resolved or literal address: never an always-denied one; a private one only inside
   * EGRESS_PRIVATE_CIDRS (SPEC §11.4).
   */
  private addressAllowed(address: string, _family?: number): boolean {
    const addr = parseAddr(address)
    if (!addr) return false
    return addressAllowed(addr, this.cidrs)
  }

  private notePlaintext(url: URL, what: string): void {
    if (url.protocol !== 'http:' || this.plaintextSeen.has(url.host)) return
    this.plaintextSeen.add(url.host)
    log.warn('egress_plaintext', { host: url.host, purpose: purposeCategory(what) })
  }

  /**
   * URL check before any network access: used at request validation to
   * answer 400 egress_denied instead of failing mid-run.
   */
  assertAllowed(rawUrl: string, what: string): URL {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new EgressDeniedError(`${what}: invalid URL`, { target: what }, 'invalid_url')
    }
    // credentials in a URL are secrets: refused, never logged (SPEC §11.4)
    if (url.username || url.password) {
      log.warn('egress_denied', { target: what, host: url.hostname, reason: 'userinfo' })
      throw new EgressDeniedError(`${what}: credentials in the URL are not allowed`, { target: what }, 'userinfo')
    }
    const port = effectivePort(url)
    const localDev = this.config.allowInsecureEgress && isLocalHostname(url.hostname)
    const providerOrigin = what === 'provider' && this.providerOrigins.has(url.origin)
    const plainOk =
      url.protocol === 'http:' && (localDev || providerOrigin || hostMatchesAllowlist(url.hostname, this.httpHosts, port))
    if (url.protocol !== 'https:' && !plainOk) {
      log.warn('egress_denied', { target: what, host: url.hostname, reason: 'scheme' })
      throw new EgressDeniedError(`${what}: only https is allowed`, { target: what }, 'scheme')
    }
    if (localDev) return url
    // an IP literal never reaches lookup, so privacy is checked here; otherwise
    // an entry like 127.0.0.1 in the allowlist would open the internal network (SPEC §11.4)
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !this.addressAllowed(literal, isIP(literal))) {
      log.warn('egress_denied', { target: what, host: url.hostname, reason: 'private_ip' })
      throw new EgressDeniedError(`${what}: private address`, { target: what, host: url.hostname }, 'private_ip')
    }
    if (providerOrigin || this.extraHosts.has(url.hostname.toLowerCase())) {
      this.notePlaintext(url, what)
      return url
    }
    if (!hostMatchesAllowlist(url.hostname, this.allowlist, port)) {
      log.warn('egress_denied', { target: what, host: url.hostname, reason: 'not_allowlisted' })
      throw new EgressDeniedError(`${what}: host is not in EGRESS_ALLOWLIST`, {
        target: what,
        host: url.hostname,
      })
    }
    this.notePlaintext(url, what)
    return url
  }

  async request(req: EgressRequest): Promise<EgressResponse> {
    const url = this.assertAllowed(req.url, req.purpose)

    const dropped: string[] = []
    const headers = filterEgressHeaders(req.headers, (name) => dropped.push(name))
    if (dropped.length > 0) {
      log.warn('egress_headers_dropped', { purpose: req.purpose, dropped, url: safeUrl(url.toString()) })
    }
    if (req.body != null) headers['Content-Type'] ??= 'application/json'
    headers['Accept'] ??= 'application/json'

    const timer = new AbortController()
    const onOuterAbort = () => timer.abort(req.signal?.reason)
    if (req.signal) {
      if (req.signal.aborted) onOuterAbort()
      else req.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timeout = setTimeout(() => timer.abort(new Error('egress_timeout')), req.timeoutMs)

    try {
      const res = await undiciFetch(url, {
        method: req.method ?? 'POST',
        headers,
        body: req.body,
        redirect: 'error', // redirects are never followed (SPEC §11.4)
        signal: timer.signal,
        dispatcher: this.agent,
      })

      const bytes = await readWithLimit(res.body, req.maxBytes, () => {
        // body over the limit: drop the connection
        timer.abort(new Error('body_too_large'))
      })

      const outHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        outHeaders[k.toLowerCase()] = v
      })

      return {
        status: res.status,
        headers: outHeaders,
        text: new TextDecoder().decode(bytes),
        bytes,
      }
    } catch (err) {
      if (isPrivateIpRefusal(err)) countEgressDenied(purposeCategory(req.purpose), 'private_ip')
      throw err
    } finally {
      clearTimeout(timeout)
      req.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  /** Image download (SPEC §5.3). */
  async fetchImage(rawUrl: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const res = await this.request({
      url: rawUrl,
      method: 'GET',
      timeoutMs: 30_000,
      maxBytes: this.config.imageMaxBytes,
      purpose: 'image',
      signal,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new EngineError('image_fetch_failed', `image: HTTP ${res.status}`)
    }
    const mediaType = (res.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
    return { bytes: res.bytes, mediaType }
  }

  /**
   * fetch for the AI SDK (openai-compatible / Anthropic): the same dispatcher with
   * pinning and no redirects, but without a body limit, since the response is a stream.
   * If the provider has a proxy, it goes through the proxy.
   */
  providerFetchFor(provider: ProviderId): typeof fetch {
    const dispatcher = this.proxies.get(provider) ?? this.agent
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      this.assertAllowed(url, 'provider')
      return (
        undiciFetch(url, {
          ...(init as Record<string, unknown>),
          redirect: 'error',
          dispatcher,
        } as never) as unknown as Promise<Response>
      ).catch((err: unknown) => {
        if (isPrivateIpRefusal(err)) countEgressDenied('provider', 'private_ip')
        throw err
      })
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.agent.close(), ...[...this.proxies.values()].map((p) => p.close())])
  }
}

/** The DNS filter refused every answer (SPEC §11.4); undici wraps it in `cause`. */
function isPrivateIpRefusal(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === 'EGRESS_PRIVATE_IP') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Streaming body read with a ceiling: exceeding it is an error, not truncation (SPEC §6.2). */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

async function readWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onOverflow: () => void,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        onOverflow()
        await reader.cancel().catch(() => {})
        throw new BodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
