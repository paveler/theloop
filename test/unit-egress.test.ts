import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'
import { APICallError } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeProxies } from '../src/config.js'
import { EgressClient, filterEgressHeaders, hostMatchesAllowlist } from '../src/egress/client.js'
import { isPrivateAddress } from '../src/egress/ip.js'
import { EngineError } from '../src/errors.js'
import { safeUrl } from '../src/log.js'
import { classifyProviderError } from '../src/runs/provider.js'
import { truncateResult } from '../src/tools/http.js'
import { testConfig } from './helpers.js'

describe('host allowlist (SPEC §11.4)', () => {
  const list = ['api.eu.example.com', '.example.com']

  it('an entry without a leading dot matches the exact host', () => {
    expect(hostMatchesAllowlist('api.eu.example.com', ['api.eu.example.com'])).toBe(true)
    expect(hostMatchesAllowlist('other.example.com', ['api.eu.example.com'])).toBe(false)
  })

  it('an entry with a leading dot matches subdomains and the domain itself', () => {
    expect(hostMatchesAllowlist('api.example.com', list)).toBe(true)
    expect(hostMatchesAllowlist('example.com', list)).toBe(true)
  })

  it('evilexample.com does not match .example.com', () => {
    expect(hostMatchesAllowlist('evilexample.com', list)).toBe(false)
  })
})

describe('egress header filter (SPEC §11.4)', () => {
  it('keeps Authorization and X-*, drops Host / Cookie / hop-by-hop', () => {
    const dropped: string[] = []
    const out = filterEgressHeaders(
      {
        Authorization: 'Bearer x',
        'X-Tenant': 't1',
        Host: 'evil.com',
        Cookie: 'a=b',
        Connection: 'keep-alive',
      },
      (n) => dropped.push(n),
    )
    expect(out).toEqual({ Authorization: 'Bearer x', 'X-Tenant': 't1' })
    expect(dropped.sort()).toEqual(['Connection', 'Cookie', 'Host'])
  })

  it('X-* exceptions: X-Forwarded-*, X-Original-*, X-Real-IP, X-HTTP-Method-Override', () => {
    const out = filterEgressHeaders({
      'X-Forwarded-For': '1.2.3.4',
      'X-Original-URL': '/admin',
      'X-Real-IP': '1.2.3.4',
      'X-HTTP-Method-Override': 'DELETE',
      'X-Ok': 'yes',
    })
    expect(out).toEqual({ 'X-Ok': 'yes' })
  })
})

describe('safeUrl: query strings in logs (SPEC §12.2)', () => {
  it('redacts the values of all parameters and keeps the names', () => {
    const out = safeUrl('https://api.example.com/hooks/runs/cb?appID=app-1&sessionID=sess-secret')
    expect(out).not.toContain('sess-secret')
    expect(out).not.toContain('app-1')
    expect(out).toContain('sessionID=')
    expect(out).toContain('/hooks/runs/cb')
  })

  it('relative access-log URL: token is redacted too', () => {
    const out = safeUrl('/runs/run_1/stream?token=abc123')
    expect(out.startsWith('/runs/run_1/stream?token=')).toBe(true)
    expect(out).not.toContain('abc123')
  })
})

describe('private addresses (SPEC §11.4)', () => {
  it('loopback / private / link-local / CGNAT are denied', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('public addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '9.9.9.9', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('IPv6: ::1, ULA, link-local and private IPv4-mapped are denied', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    // hex form: this is how URL normalizes [::ffff:127.0.0.1]
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
    expect(isPrivateAddress('::ffff:a00:1')).toBe(true)
    expect(isPrivateAddress('::ffff:808:808')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })
})

describe('assertAllowed', () => {
  const client = new EgressClient(testConfig({ ALLOW_INSECURE_EGRESS: '0' }))

  it('http is denied', () => {
    expect(() => client.assertAllowed('http://tools.example.com/x', 'tool')).toThrowError(EngineError)
  })

  it('a host outside the allowlist is denied', () => {
    try {
      client.assertAllowed('https://evil.example.org/x', 'tool')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as EngineError).code).toBe('egress_denied')
    }
  })

  it('an allowed host passes, and so does a built-in provider host', () => {
    expect(client.assertAllowed('https://tools.example.com/x', 'tool').hostname).toBe('tools.example.com')
    client.allowHost('api.anthropic.com')
    expect(client.assertAllowed('https://api.anthropic.com/v1/messages', 'provider').hostname).toBe(
      'api.anthropic.com',
    )
  })
})

describe('tool result truncation (SPEC §6.2)', () => {
  it('a short result is left as is', () => {
    expect(truncateResult({ a: 1 }, 1000)).toEqual({ kind: 'ok', result: { a: 1 }, truncated: false })
  })

  it('a long one is cut with a marker and truncated: true', () => {
    const outcome = truncateResult({ data: 'x'.repeat(500) }, 100)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.truncated).toBe(true)
    expect(String(outcome.result)).toMatch(/…\[truncated, \d+ bytes total\]$/)
  })
})

describe('provider proxies (SPEC §11.4)', () => {
  it('ANTHROPIC_PROXY_URL is read, other providers go without a proxy', () => {
    const config = testConfig({ ANTHROPIC_PROXY_URL: 'http://user:secret@proxy.example.net:3128' })
    expect(config.providerProxies).toEqual({ anthropic: 'http://user:secret@proxy.example.net:3128' })
  })

  it('a bad scheme or URL stops the engine at startup, the value stays out of the error', () => {
    expect(() => testConfig({ ANTHROPIC_PROXY_URL: 'ftp://user:secret@proxy.example.net' })).toThrowError(
      /ANTHROPIC_PROXY_URL: scheme ftp: is not supported/,
    )
    try {
      testConfig({ OPENAI_PROXY_URL: 'user:secret@::bad' })
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as Error).message).toMatch(/OPENAI_PROXY_URL/)
      expect((err as Error).message).not.toContain('secret')
    }
  })

  it('the log gets only the scheme and host:port, no login or password', () => {
    const config = testConfig({ ANTHROPIC_PROXY_URL: 'socks5://user:secret@proxy.example.net:1080' })
    expect(describeProxies(config)).toEqual({ anthropic: 'socks5://proxy.example.net:1080' })
  })

  describe('live CONNECT proxy on loopback', () => {
    const tunnels: Array<{ target: string; auth: string | undefined }> = []
    let target: Server
    let proxy: Server
    let targetUrl: string
    let proxyPort: number
    const clients: EgressClient[] = []

    beforeAll(async () => {
      target = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
      targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/v1/messages`

      proxy = createServer((_req, res) => {
        res.writeHead(405)
        res.end()
      })
      proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
        const auth = req.headers['proxy-authorization']
        tunnels.push({ target: req.url ?? '', auth })
        if (auth !== `Basic ${Buffer.from('user:secret').toString('base64')}`) {
          client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
          return
        }
        const port = Number((req.url ?? '').split(':').pop())
        const upstream = netConnect(port, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      proxyPort = (proxy.address() as AddressInfo).port
    })

    afterAll(async () => {
      await Promise.all(clients.map((c) => c.close()))
      proxy.closeAllConnections()
      target.closeAllConnections()
      await new Promise((resolve) => proxy.close(resolve))
      await new Promise((resolve) => target.close(resolve))
    })

    function clientWith(proxyUrl: string): EgressClient {
      const client = new EgressClient(testConfig({ ANTHROPIC_PROXY_URL: proxyUrl }))
      clients.push(client)
      return client
    }

    it('anthropic goes through the proxy with Proxy-Authorization, openai goes direct', async () => {
      const client = clientWith(`http://user:secret@127.0.0.1:${proxyPort}`)
      tunnels.length = 0

      const res = await client.providerFetchFor('anthropic')(targetUrl, { method: 'POST', body: '{}' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(tunnels).toHaveLength(1)
      expect(tunnels[0]!.target).toBe(new URL(targetUrl).host)

      const direct = await client.providerFetchFor('openai')(targetUrl, { method: 'POST', body: '{}' })
      expect(direct.status).toBe(200)
      await direct.arrayBuffer()
      expect(tunnels).toHaveLength(1)
    })

    it('proxy refused (407): the reason reaches provider_failure', async () => {
      const client = clientWith(`http://user:wrong@127.0.0.1:${proxyPort}`)
      const err = await client
        .providerFetchFor('anthropic')(targetUrl, { method: 'POST', body: '{}' })
        .then(() => null, (e: unknown) => e as Error & { cause?: Error })
      expect(err).not.toBeNull()
      expect(classifyProviderError(err).message).toMatch(/Proxy response \(407\)/)

      // this is how the AI SDK wraps a fetch error (handleFetchError): it keeps only the first cause
      const wrapped = new APICallError({
        message: `Cannot connect to API: ${err!.cause!.message}`,
        url: targetUrl,
        requestBodyValues: {},
        cause: err!.cause,
        isRetryable: true,
      })
      const failure = classifyProviderError(wrapped)
      expect(failure.code).toBe('provider_unavailable')
      expect(failure.message).toMatch(/Proxy response \(407\)/)
    })
  })
})
