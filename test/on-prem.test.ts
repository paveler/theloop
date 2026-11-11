/**
 * On-prem and closed networks (RFC 0004): private-range egress, plain http for listed hosts,
 * ports, public providers off, base URL overrides, model endpoints (keyless, reasoning replay,
 * concurrency scope, the public reference), secrets from files, /metrics, /health detail.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from '../src/app.js'
import { createConfig } from '../src/config.js'
import { addressAllowed, alwaysDenied, inListedRange, parseAddr, parseCidrList } from '../src/egress/cidr.js'
import { EgressClient, hostMatchesAllowlist } from '../src/egress/client.js'
import { buildModel, renameReasoning } from '../src/providers/factory.js'
import type { Llm } from '../src/contracts.js'
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
  type LocalServer,
} from './helpers.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function track(engine: Engine): Engine {
  cleanup.push(() => engine.shutdown())
  return engine
}

async function server(handler: Parameters<typeof startServer>[0]): Promise<LocalServer> {
  const s = await startServer(handler)
  cleanup.push(() => s.close())
  return s
}

const baseEnv = { PORT: '0', ENGINE_TOKEN, LOG_LEVEL: 'silent' }

function llm(overrides: Partial<Llm>): Llm {
  return { provider: 'anthropic', model: 'm', params: {}, ...overrides } as Llm
}

/* ------------------------------------------------------------------ Part A */

describe('private ranges (SPEC §11.4)', () => {
  it('parses ranges and refuses malformed, never-allowed and translation ranges', () => {
    expect(parseCidrList('10.20.0.0/16, fd12:3456::/48').map((c) => c.text)).toEqual(['10.20.0.0/16', 'fd12:3456::/48'])
    expect(() => parseCidrList('10.20.0.0/33')).toThrow(/not a CIDR/)
    expect(() => parseCidrList('nonsense')).toThrow(/not a CIDR/)
    expect(() => parseCidrList('169.254.0.0/16')).toThrow(/never allowed/)
    expect(() => parseCidrList('0.0.0.0/0')).toThrow(/never allowed/)
    expect(() => parseCidrList('fe80::/64')).toThrow(/never allowed/)
    expect(() => parseCidrList('::ffff:0:0/96')).toThrow(/translation/)
    expect(() => parseCidrList('64:ff9b::/96')).toThrow(/translation/)
    expect(() => parseCidrList('2002::/16')).toThrow(/translation/)
  })

  it('normalizes mapped forms before every check; denies win', () => {
    const cidrs = parseCidrList('10.20.0.0/16')
    expect(inListedRange(parseAddr('10.20.3.4')!, cidrs)).toBe(true)
    expect(inListedRange(parseAddr('::ffff:10.20.3.4')!, cidrs)).toBe(true)
    expect(inListedRange(parseAddr('::ffff:a14:304')!, cidrs)).toBe(true)
    expect(inListedRange(parseAddr('10.21.0.1')!, cidrs)).toBe(false)
    expect(inListedRange(parseAddr('127.0.0.1')!, cidrs)).toBe(false)
    expect(alwaysDenied(parseAddr('::ffff:a9fe:a9fe')!)).toBe(true) // 169.254.169.254
    expect(alwaysDenied(parseAddr('64:ff9b::a9fe:a9fe')!)).toBe(true)
    expect(alwaysDenied(parseAddr('2002:a9fe:a9fe::1')!)).toBe(true)
    expect(alwaysDenied(parseAddr('::')!)).toBe(true)
    expect(alwaysDenied(parseAddr('224.0.0.1')!)).toBe(true)
  })

  it('private by bytes: 6to4 / NAT64 carrying a private IPv4, expanded spellings', () => {
    const none = parseCidrList('')
    const listed = parseCidrList('127.0.0.0/8,10.0.0.0/8')
    for (const ip of ['2002:7f00:1::1', '2002:0a00:0001::1', '64:ff9b::7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:0000:0000:0001']) {
      expect(addressAllowed(parseAddr(ip)!, none)).toBe(false)
    }
    // a translated private IPv4 is never opened by a range
    expect(addressAllowed(parseAddr('2002:7f00:1::1')!, listed)).toBe(false)
    expect(addressAllowed(parseAddr('::ffff:127.0.0.1')!, listed)).toBe(true)
    expect(addressAllowed(parseAddr('2002:0808:0808::1')!, none)).toBe(true)
    expect(addressAllowed(parseAddr('8.8.8.8')!, none)).toBe(true)
    const egress = new EgressClient(createConfig({ ...baseEnv, EGRESS_ALLOWLIST: '2002:7f00:1::1' }))
    expect(() => egress.assertAllowed('https://[2002:7f00:1::1]/x', 'tool:t')).toThrow(/private address/)
  })

  it('ports in allowlist entries', () => {
    expect(hostMatchesAllowlist('llm.corp', ['llm.corp:8000'], 8000)).toBe(true)
    expect(hostMatchesAllowlist('llm.corp', ['llm.corp:8000'], 8001)).toBe(false)
    expect(hostMatchesAllowlist('a.svc.corp', ['.svc.corp:443'], 443)).toBe(true)
    expect(hostMatchesAllowlist('llm.corp', ['llm.corp'], 9999)).toBe(true)
    expect(hostMatchesAllowlist('fd00::1', ['[fd00::1]:8000'], 8000)).toBe(true)
  })

  it('a private literal passes only inside a listed range and the allowlist; userinfo is refused', () => {
    const egress = new EgressClient(
      createConfig({
        ...baseEnv,
        EGRESS_ALLOWLIST: '10.20.0.5,10.30.0.5,tools.corp:8443',
        EGRESS_PRIVATE_CIDRS: '10.20.0.0/16',
        EGRESS_HTTP_HOSTS: '10.20.0.5:8080',
      }),
    )
    expect(() => egress.assertAllowed('https://10.20.0.5/x', 'tool:t')).not.toThrow()
    expect(() => egress.assertAllowed('http://10.20.0.5:8080/x', 'tool:t')).not.toThrow()
    expect(() => egress.assertAllowed('http://10.20.0.5:9090/x', 'tool:t')).toThrow(/only https/)
    expect(() => egress.assertAllowed('https://10.30.0.5/x', 'tool:t')).toThrow(/private address/)
    expect(() => egress.assertAllowed('https://tools.corp:8443/x', 'tool:t')).not.toThrow()
    expect(() => egress.assertAllowed('https://tools.corp/x', 'tool:t')).toThrow(/EGRESS_ALLOWLIST/)
    expect(() => egress.assertAllowed('https://u:p@tools.corp:8443/x', 'tool:t')).toThrow(/credentials/)
    expect(() => egress.assertAllowed('https://[::ffff:a9fe:a9fe]/x', 'tool:t')).toThrow(/private address/)
  })

  it('a tool on a listed private range over plain http, through DNS for a name', async () => {
    const tools = await server((_b, _r, res) => json(res, 200, { status: 'ok', result: { state: 'ok' } }))
    const port = new URL(tools.url).port
    const model = mockModel([
      streamFrom([START, { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: '{}' }, finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(
      createEngine(
        createConfig({
          ...baseEnv,
          EGRESS_ALLOWLIST: `localhost:${port}`,
          EGRESS_HTTP_HOSTS: `localhost:${port}`,
          EGRESS_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
        }),
        { modelFactory: mockFactory(model) },
      ),
    )
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(
        runRequest({
          tools: [{ name: 't', endpoint: `http://localhost:${port}/t`, effect: 'read', input_schema: { type: 'object' } }] as never,
        }),
      ),
    })
    const result = (await res.json()) as { status: string; messages: Array<{ role: string; result?: unknown }> }
    expect(result.status).toBe('completed')
    expect(tools.requests).toHaveLength(1)
    expect(result.messages.find((m) => m.role === 'tool')?.result).toEqual({ state: 'ok' })
  })

  it('without the range the same tool is refused at connect time', async () => {
    const tools = await server((_b, _r, res) => json(res, 200, { status: 'ok', result: {} }))
    const port = new URL(tools.url).port
    const model = mockModel([
      streamFrom([START, { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: '{}' }, finish('tool-calls')]),
      streamFrom([START, ...textChunks('done'), finish('stop')]),
    ])
    const engine = track(
      createEngine(
        createConfig({ ...baseEnv, EGRESS_ALLOWLIST: `localhost:${port}`, EGRESS_HTTP_HOSTS: `localhost:${port}` }),
        { modelFactory: mockFactory(model) },
      ),
    )
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(
        runRequest({
          tools: [{ name: 't', endpoint: `http://localhost:${port}/t`, effect: 'read', input_schema: { type: 'object' } }] as never,
        }),
      ),
    })
    const result = (await res.json()) as { messages: Array<{ role: string; error?: string }> }
    expect(tools.requests).toHaveLength(0)
    expect(result.messages.find((m) => m.role === 'tool')?.error).toMatch(/egress_denied/)
  })

  it('EGRESS_PUBLIC_PROVIDERS=0: a named provider without an override is refused on receipt', () => {
    const config = createConfig({ ...baseEnv, EGRESS_PUBLIC_PROVIDERS: '0', ANTHROPIC_API_KEY: 'k' })
    const egress = new EgressClient(config)
    expect(() => buildModel(llm({ provider: 'anthropic' }), config, egress)).toThrow(/public provider hosts are off/)
  })

  it('EGRESS_PUBLIC_PROVIDERS=0 through POST /runs: 400 egress_denied naming the entry', async () => {
    const engine = track(createEngine(createConfig({ ...baseEnv, EGRESS_PUBLIC_PROVIDERS: '0' })))
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest({ llm: [{ provider: 'openai', model: 'gpt-5', api_key: 'k' }] as never })),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('egress_denied')
    expect(body.error.message).toMatch(/^llm\.0/)
  })
})

/* ------------------------------------------------------------------ Part B */

describe('base URL overrides (SPEC §9.1)', () => {
  it('an override is validated at startup and conflicts with a proxy', () => {
    expect(() => createConfig({ ...baseEnv, OPENAI_BASE_URL: 'not a url' })).toThrow(/OPENAI_BASE_URL: invalid URL/)
    expect(() => createConfig({ ...baseEnv, OPENAI_BASE_URL: 'https://u:p@gw.corp/v1' })).toThrow(/credentials/)
    expect(() => createConfig({ ...baseEnv, OPENAI_BASE_URL: 'http://gw.corp/v1' })).toThrow(/EGRESS_HTTP_HOSTS/)
    expect(() =>
      createConfig({ ...baseEnv, OPENAI_BASE_URL: 'https://gw.corp/v1', OPENAI_PROXY_URL: 'http://proxy.corp:3128' }),
    ).toThrow(/proxy cannot be combined/)
    expect(createConfig({ ...baseEnv, OPENAI_BASE_URL: 'https://gw.corp/v1/' }).providerBaseUrls.openai).toBe('https://gw.corp/v1')
  })

  it('GigaChat: the API and OAuth overrides go together', () => {
    expect(() => createConfig({ ...baseEnv, GIGACHAT_BASE_URL: 'https://giga.corp/api/v1' })).toThrow(/go together/)
    expect(() => createConfig({ ...baseEnv, GIGACHAT_OAUTH_URL: 'https://giga.corp/oauth' })).toThrow(/go together/)
    const config = createConfig({ ...baseEnv, GIGACHAT_BASE_URL: 'https://giga.corp/api/v1', GIGACHAT_OAUTH_URL: 'https://giga.corp/oauth' })
    expect(config.gigachatOAuthUrl).toBe('https://giga.corp/oauth')
  })

  it('a request to an overridden provider goes to the override with the env key', async () => {
    const gw = await server((body, req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(openaiStream([{ content: 'from the gateway' }], true))
    })
    const port = new URL(gw.url).port
    const engine = track(
      createEngine(
        createConfig({
          ...baseEnv,
          OPENAI_BASE_URL: `http://localhost:${port}/v1`,
          OPENAI_API_KEY: 'env-gw-key',
          EGRESS_HTTP_HOSTS: `localhost:${port}`,
          EGRESS_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
          EGRESS_PUBLIC_PROVIDERS: '0',
        }),
      ),
    )
    const result = await post(engine, runRequest({ llm: { provider: 'openai', model: 'gpt-5' } as never }))
    expect(result.status).toBe('completed')
    expect(gw.requests[0]!.path).toBe('/v1/chat/completions')
    expect(gw.requests[0]!.headers.authorization).toBe('Bearer env-gw-key')
  })
})

/** OpenAI chat-completions SSE from deltas; usage in the last chunk when asked. */
function openaiStream(deltas: Array<Record<string, unknown>>, usage = false, finishReason = 'stop'): string {
  const chunks = deltas.map((delta) => ({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta }] }))
  chunks.push({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason } as never],
    ...(usage ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  } as never)
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function anthropicStream(text: string): string {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

async function post(engine: Engine, body: Record<string, unknown>): Promise<any> {
  const res = await engine.app.request('/runs', { method: 'POST', headers: bearer(), body: JSON.stringify(body) })
  return res.json()
}

/** An engine with one endpoint at a local fake server. */
async function endpointEngine(
  handler: (body: any, req: IncomingMessage, res: ServerResponse) => void,
  env: Record<string, string> = {},
): Promise<{ engine: Engine; srv: LocalServer }> {
  const srv = await server(handler)
  const port = new URL(srv.url).port
  const engine = track(
    createEngine(
      createConfig({
        ...baseEnv,
        LLM_ENDPOINT_LOCAL_URL: `http://localhost:${port}/v1`,
        LLM_ENDPOINT_LOCAL_CONTEXT_WINDOW: '32000',
        EGRESS_HTTP_HOSTS: `localhost:${port}`,
        EGRESS_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
        EGRESS_PUBLIC_PROVIDERS: '0',
        // the SDK must never pick these up for a keyless endpoint
        ANTHROPIC_API_KEY: 'sk-ant-env-must-not-leak',
        OPENAI_API_KEY: 'sk-openai-env-must-not-leak',
        ...env,
      }),
    ),
  )
  return { engine, srv }
}

const endpointLlm = { provider: 'endpoint', endpoint: 'local', model: 'qwen3:8b' }

describe('model endpoints (SPEC §9.1)', () => {
  it('parses LLM_ENDPOINT_<NAME>_* and refuses broken definitions', () => {
    const config = createConfig({
      ...baseEnv,
      LLM_ENDPOINT_VLLM_MAIN_URL: 'https://vllm.corp/v1',
      LLM_ENDPOINT_VLLM_MAIN_MAX_CONCURRENCY: '4',
      LLM_ENDPOINT_GW_URL: 'https://gw.corp/anthropic/v1',
      LLM_ENDPOINT_GW_KIND: 'anthropic',
      LLM_ENDPOINT_GW_PREFIX_BINDING: '1',
    })
    expect(config.endpoints['vllm-main']).toMatchObject({ kind: 'openai', maxConcurrency: 4, thinking: 'effort', reasoningReplay: 'none', concurrencyScope: 'endpoint' })
    expect(config.endpoints.gw).toMatchObject({ kind: 'anthropic', reasoning: 'signed', prefixBinding: true, thinking: 'budget' })
    expect(() => createConfig({ ...baseEnv, LLM_ENDPOINT_X_KIND: 'openai' })).toThrow(/LLM_ENDPOINT_X_URL is required/)
    expect(() => createConfig({ ...baseEnv, LLM_ENDPOINT_X_URL: 'https://x/v1', LLM_ENDPOINT_X_KIND: 'grpc' })).toThrow(/one of openai, anthropic/)
    expect(() => createConfig({ ...baseEnv, LLM_ENDPOINT_X_URL: 'https://x/v1', LLM_ENDPOINT_X_PREFIX_BINDING: '1' })).toThrow(/PREFIX_BINDING/)
    expect(() => createConfig({ ...baseEnv, LLM_ENDPOINT_X_URL: 'https://x/v1', LLM_ENDPOINT_X_COLOR: 'red' })).toThrow(/unknown endpoint setting/)
    expect(() => createConfig({ ...baseEnv, LLM_ENDPOINT_X_URL: 'http://x/v1' })).toThrow(/EGRESS_HTTP_HOSTS/)
  })

  it('request rules: endpoint required, unknown named, forbidden elsewhere', () => {
    const config = createConfig({ ...baseEnv, LLM_ENDPOINT_LOCAL_URL: 'https://llm.corp/v1', ANTHROPIC_API_KEY: 'k' })
    const egress = new EgressClient(config)
    expect(() => buildModel(llm({ provider: 'endpoint' }), config, egress)).toThrow(/requires llm.endpoint/)
    expect(() => buildModel(llm({ provider: 'endpoint', endpoint: 'nope' }), config, egress)).toThrow(/unknown endpoint "nope"; known: local/)
    expect(() => buildModel(llm({ provider: 'anthropic', endpoint: 'local' }), config, egress)).toThrow(/only for provider "endpoint"/)
    expect(() => buildModel(llm({ provider: 'endpoint', endpoint: 'local', base_url: 'https://x/v1' }), config, egress)).toThrow(/base_url/)
  })

  it('keyless openai-kind: no credential header even with every env key set; public reference everywhere', async () => {
    const { engine, srv } = await endpointEngine((_b, _r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(openaiStream([{ content: 'hello from ollama' }], true))
    })
    const result = await post(engine, runRequest({ llm: endpointLlm as never }))
    expect(result.status).toBe('completed')
    const headers = srv.requests[0]!.headers
    expect(headers.authorization).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(JSON.stringify(srv.requests)).not.toContain('must-not-leak')
    expect(result.usage.calls[0]).toMatchObject({ provider: 'endpoint', endpoint: 'local', model: 'qwen3:8b' })
  })

  it('keyless anthropic-kind: the SDK does not fall back to ANTHROPIC_API_KEY', async () => {
    const { engine, srv } = await endpointEngine(
      (_b, _r, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(anthropicStream('hi'))
      },
      { LLM_ENDPOINT_LOCAL_KIND: 'anthropic' },
    )
    const result = await post(engine, runRequest({ llm: endpointLlm as never }))
    expect(result.status).toBe('completed')
    expect(srv.requests[0]!.path).toBe('/v1/messages')
    expect(srv.requests[0]!.headers['x-api-key']).toBeUndefined()
    expect(srv.requests[0]!.headers.authorization).toBeUndefined()
  })

  it('a key from the request is sent; the endpoint key is the fallback', async () => {
    const { engine, srv } = await endpointEngine(
      (_b, _r, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(openaiStream([{ content: 'ok' }]))
      },
      { LLM_ENDPOINT_LOCAL_API_KEY: 'endpoint-key' },
    )
    await post(engine, runRequest({ llm: endpointLlm as never }))
    await post(engine, runRequest({ llm: { ...endpointLlm, api_key: 'tenant-key' } as never }))
    expect(srv.requests[0]!.headers.authorization).toBe('Bearer endpoint-key')
    expect(srv.requests[1]!.headers.authorization).toBe('Bearer tenant-key')
  })

  it('Ollama-style stream: a whole tool call in one chunk, reasoning in `reasoning`, no usage → estimated', async () => {
    const tools = await server((_b, _r, res) => json(res, 200, { status: 'ok', result: { stock: 3 } }))
    const toolPort = new URL(tools.url).port
    let call = 0
    const { engine, srv } = await endpointEngine(
      (_b, _r, res) => {
        call++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (call === 1) {
          res.end(
            openaiStream(
              [
                { reasoning: 'I should check stock.' },
                { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'getStock', arguments: '{"sku":"A1"}' } }] },
              ],
              false,
              'tool_calls',
            ),
          )
        } else {
          res.end(openaiStream([{ content: '3 left' }]))
        }
      },
      {
        LLM_ENDPOINT_LOCAL_REASONING_REPLAY: 'reasoning',
        EGRESS_ALLOWLIST: `localhost:${toolPort}`,
        EGRESS_HTTP_HOSTS: 'localhost',
      },
    )
    const result = await post(
      engine,
      runRequest({
        llm: endpointLlm as never,
        tools: [{ name: 'getStock', endpoint: `http://localhost:${toolPort}/stock`, effect: 'read', input_schema: { type: 'object' } }] as never,
      }),
    )
    expect(result.status).toBe('completed')
    expect(tools.requests).toHaveLength(1)
    const assistant = result.messages.find((m: any) => m.role === 'assistant')
    expect(assistant.content.find((p: any) => p.type === 'reasoning')).toMatchObject({ text: 'I should check stock.', provider: 'endpoint:local' })
    expect(result.usage.calls[0].estimated).toBe(true)
    // the second request replays reasoning in the field Ollama / vLLM read
    const second = srv.requests[1]!.body as { messages: Array<Record<string, unknown>> }
    const replayed = second.messages.find((m) => m.role === 'assistant')!
    expect(replayed.reasoning).toBe('I should check stock.')
    expect(replayed).not.toHaveProperty('reasoning_content')
    expect(replayed.tool_calls).toBeDefined()
  })

  it('_REASONING_REPLAY=none (default): stored, not sent back', async () => {
    let call = 0
    const tools = await server((_b, _r, res) => json(res, 200, { status: 'ok', result: {} }))
    const toolPort = new URL(tools.url).port
    const { engine, srv } = await endpointEngine(
      (_b, _r, res) => {
        call++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(
          call === 1
            ? openaiStream(
                [
                  { reasoning_content: 'thinking' },
                  { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] },
                ],
                true,
                'tool_calls',
              )
            : openaiStream([{ content: 'ok' }], true),
        )
      },
      { EGRESS_ALLOWLIST: `localhost:${toolPort}`, EGRESS_HTTP_HOSTS: 'localhost' },
    )
    const result = await post(
      engine,
      runRequest({
        llm: endpointLlm as never,
        tools: [{ name: 't', endpoint: `http://localhost:${toolPort}/t`, effect: 'read', input_schema: { type: 'object' } }] as never,
      }),
    )
    expect(result.status).toBe('completed')
    const replayed = (srv.requests[1]!.body as any).messages.find((m: any) => m.role === 'assistant')
    expect(replayed).not.toHaveProperty('reasoning_content')
    expect(replayed).not.toHaveProperty('reasoning')
  })

  it('the endpoint origin is not opened for tools (purpose scoping)', async () => {
    const { engine, srv } = await endpointEngine((_b, _r, res) => json(res, 200, {}))
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(
        runRequest({
          llm: endpointLlm as never,
          tools: [{ name: 't', endpoint: `${srv.url.replace('127.0.0.1', 'localhost')}/v1/admin`, effect: 'read', input_schema: { type: 'object' } }] as never,
        }),
      ),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('egress_denied')
  })

  it('concurrency scope: one queue per server by default, per key with CONCURRENCY_SCOPE=key', () => {
    const make = (scope?: string) =>
      createConfig({
        ...baseEnv,
        LLM_ENDPOINT_LOCAL_URL: 'https://llm.corp/v1',
        LLM_ENDPOINT_LOCAL_MAX_CONCURRENCY: '2',
        ...(scope ? { LLM_ENDPOINT_LOCAL_CONCURRENCY_SCOPE: scope } : {}),
      })
    for (const [scope, same] of [[undefined, true], ['key', false]] as const) {
      const config = make(scope)
      const egress = new EgressClient(config)
      const a = buildModel(llm({ provider: 'endpoint', endpoint: 'local', api_key: 'a' }), config, egress)
      const b = buildModel(llm({ provider: 'endpoint', endpoint: 'local', api_key: 'b' }), config, egress)
      expect(a.throttleKey.provider).toBe('endpoint:local')
      expect(a.throttleKey.max).toBe(2)
      expect(a.throttleKey.hash === b.throttleKey.hash).toBe(same)
    }
  })

  it('a chain mixing an endpoint and a named provider: llm_used carries the endpoint', async () => {
    const { engine } = await endpointEngine(
      (_b, _r, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(openaiStream([{ content: 'ok' }]))
      },
      { EGRESS_ALLOWLIST: 'tools.example.com' },
    )
    const result = await post(
      engine,
      runRequest({ llm: [endpointLlm, { provider: 'openai-compatible', model: 'x', base_url: 'https://tools.example.com/v1', api_key: 'k' }] as never }),
    )
    expect(result.llm_used).toEqual({ index: 0, provider: 'endpoint', endpoint: 'local', model: 'qwen3:8b' })
  })

  it('renameReasoning moves reasoning_content to reasoning only', () => {
    const body = JSON.stringify({ messages: [{ role: 'assistant', reasoning_content: 'r', content: 'x' }, { role: 'user', content: 'y' }] })
    expect(JSON.parse(renameReasoning(body)).messages[0]).toEqual({ role: 'assistant', reasoning: 'r', content: 'x' })
    expect(renameReasoning('not json')).toBe('not json')
  })
})

/* ------------------------------------------------------------------ Part E */

describe('secrets from files (SPEC §14)', () => {
  it('reads _FILE twins, trims one newline, refuses both set and empty files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'theloop-secrets-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'token'), 'file-token\n')
    writeFileSync(join(dir, 'key'), 'sk-from-file\n')
    writeFileSync(join(dir, 'empty'), '\n')
    const config = createConfig({ PORT: '0', ENGINE_TOKEN_FILE: join(dir, 'token'), ANTHROPIC_API_KEY_FILE: join(dir, 'key') })
    expect(config.engineTokens).toEqual(['file-token'])
    expect(config.providerKeys.anthropic).toBe('sk-from-file')
    expect(() => createConfig({ PORT: '0', ENGINE_TOKEN: 't', ENGINE_TOKEN_FILE: join(dir, 'token') })).toThrow(/both set/)
    expect(() => createConfig({ PORT: '0', ENGINE_TOKEN_FILE: join(dir, 'empty') })).toThrow(/is empty/)
    expect(() => createConfig({ PORT: '0', ENGINE_TOKEN_FILE: join(dir, 'missing') })).toThrow(/cannot read/)
  })
})

describe('GET /metrics (SPEC §4.10)', () => {
  it('off without METRICS_TOKEN; its own token only, never ENGINE_TOKEN', async () => {
    const off = track(createEngine(testConfig()))
    expect((await off.app.request('/metrics', { headers: bearer() })).status).toBe(404)
    const on = track(createEngine(testConfig({ METRICS_TOKEN: 'scrape-me' })))
    expect((await on.app.request('/metrics', { headers: bearer() })).status).toBe(401)
    expect((await on.app.request('/metrics')).status).toBe(401)
    const ok = await on.app.request('/metrics', { headers: { Authorization: 'Bearer scrape-me' } })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('theloop_runs_active')
  })

  it('counts runs, attempts and tokens; the model label is capped', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('hi'), finish('stop', { inputTokens: 50, outputTokens: 5 })]))
    const engine = track(createEngine(testConfig({ METRICS_TOKEN: 'm', METRICS_MAX_MODELS: '1' }), { modelFactory: mockFactory(model) }))
    await post(engine, runRequest({ llm: { provider: 'anthropic', model: 'model-a', api_key: 'k' } as never }))
    await post(engine, runRequest({ llm: { provider: 'anthropic', model: 'model-b', api_key: 'k' } as never }))
    const text = await (await engine.app.request('/metrics', { headers: { Authorization: 'Bearer m' } })).text()
    expect(text).toContain('theloop_runs_started_total 2')
    expect(text).toContain('theloop_runs_finished_total{status="completed",finish_reason="end_turn"} 2')
    expect(text).toContain('theloop_provider_attempts_total{provider="anthropic",model="model-a",outcome="ok",status_class="2xx"} 1')
    expect(text).toContain('model="other"')
    expect(text).toContain('theloop_tokens_total{provider="anthropic",model="model-a",kind="input"} 50')
    expect(text).not.toMatch(/key=|session|run_/)
  })

  it('egress refusals with distinct tool names are one series per purpose and reason', async () => {
    const engine = track(createEngine(testConfig({ METRICS_TOKEN: 'm' })))
    for (const name of ['a', 'b', 'c']) {
      await engine.app.request('/runs', {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify(runRequest({ tools: [{ name, endpoint: 'https://evil.example.org/x', effect: 'read' }] as never })),
      })
    }
    const text = await (await engine.app.request('/metrics', { headers: { Authorization: 'Bearer m' } })).text()
    const lines = text.split('\n').filter((l) => l.startsWith('theloop_egress_denied_total{'))
    expect(lines).toEqual(['theloop_egress_denied_total{purpose="tool",reason="not_allowlisted"} 3'])
  })
})

describe('/health detail (SPEC §4.7)', () => {
  it('HEALTH_DETAILS=0: ok / shutting_down only, the full body with ENGINE_TOKEN', async () => {
    const engine = track(createEngine(testConfig({ HEALTH_DETAILS: '0' })))
    expect(await (await engine.app.request('/health')).json()).toEqual({ ok: true, shutting_down: false })
    const full = (await (await engine.app.request('/health', { headers: bearer() })).json()) as Record<string, unknown>
    expect(full).toHaveProperty('version')
    expect(full).toHaveProperty('provider_throttle')
  })
})
