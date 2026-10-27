/** Shared test helpers: config, mock model, local tool / callback servers. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import type {
  LanguageModelV3,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { createConfig, type Config } from '../src/config.js'
import type { RunRequest } from '../src/contracts.js'
import type { ModelFactory, ResolvedModel } from '../src/providers/factory.js'

export const ENGINE_TOKEN = 'test-engine-token'

export function testConfig(overrides: Record<string, string> = {}): Config {
  return createConfig({
    PORT: '0',
    PUBLIC_URL: 'http://localhost:8080',
    ENGINE_TOKEN,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    EGRESS_ALLOWLIST: 'tools.example.com,.example.net',
    ALLOW_INSECURE_EGRESS: '1',
    RUN_RETENTION_MS: '600000',
    RUN_RETENTION_UNACKED_MS: '3600000',
    LOG_LEVEL: 'silent',
    ...overrides,
  })
}

export function streamFrom(parts: LanguageModelV3StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: 0 }) }
}

export const START: LanguageModelV3StreamPart = { type: 'stream-start', warnings: [] }

export function textChunks(text: string, id = 't1'): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ]
}

/** inputTokens is the total prompt, cache read included, as the v3 provider spec reports it. */
export function finish(
  finishReason: LanguageModelV3FinishReason['unified'],
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {},
): LanguageModelV3StreamPart {
  const total = usage.inputTokens ?? 100
  const cacheRead = usage.cachedInputTokens
  return {
    type: 'finish',
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: {
        total,
        noCache: cacheRead != null ? total - cacheRead : total,
        cacheRead,
        cacheWrite: undefined,
      },
      outputTokens: { total: usage.outputTokens ?? 10, text: undefined, reasoning: undefined },
    },
  }
}

export function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV3StreamPart {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }
}

type DoStream = LanguageModelV3['doStream']
type StreamResult = Awaited<ReturnType<DoStream>>

/**
 * NB: the doStream array of the mock model is indexed from 1 (an off-by-one bug since
 * ai@5: doStreamCalls.push runs BEFORE doStream[length] is read), so the stream queue is
 * unrolled into a function with its own counter.
 */
export function mockModel(doStream: DoStream | StreamResult[]): MockLanguageModelV3 {
  if (Array.isArray(doStream)) {
    const queue = doStream
    let index = 0
    return new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        const next = queue[index++]
        if (!next) throw new Error(`mockModel: no prepared stream for call #${index}`)
        return next
      },
    })
  }
  return new MockLanguageModelV3({ provider: 'mock', modelId: 'mock-model', doStream })
}

export function mockFactory(
  model: MockLanguageModelV3,
  overrides: Partial<ResolvedModel> = {},
): ModelFactory {
  return () => ({
    providerId: 'anthropic',
    model: model as never,
    capabilities: { parallel_tools: true, usage_in_stream: true },
    contextWindow: 200_000,
    maxTokensCap: 32_000,
    supportsCacheControl: false,
    honorsToolChoiceNone: true,
    acceptsSampling: true,
    providerOptions: {},
    throttleKey: { provider: 'anthropic', hash: 'test-key-hash' },
    ...overrides,
  })
}

/* ---------------------------------------------------------- local servers */

export interface LocalServer {
  url: string
  requests: Array<{ path: string; headers: Record<string, string>; body: unknown }>
  close: () => Promise<void>
}

export async function startServer(
  handler: (body: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<LocalServer> {
  const requests: LocalServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      requests.push({
        path: req.url ?? '/',
        headers: req.headers as Record<string, string>,
        body,
      })
      void handler(body, req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

/* --------------------------------------------------------------- requests */

export function runRequest(overrides: Partial<RunRequest> = {}): Record<string, unknown> {
  return {
    contract_version: '1',
    llm: { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-test' },
    system: 'You are an assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    wait: true,
    ...overrides,
  } as Record<string, unknown>
}

export function bearer(token = ENGINE_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/** A stream that emits its beginning and hangs until aborted — for cancel / timeout tests. */
export function hangingStream(
  parts: LanguageModelV3StreamPart[],
  signal?: AbortSignal,
): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        const onAbort = () => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      },
    }),
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Reads an SSE response until the predicate holds (or until the timeout). */
export async function readSseUntil(
  res: Response,
  until: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (until(buffer)) return buffer
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      if (until(buffer)) return buffer
      if (done) return buffer
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return buffer
}

/** Parses SSE text into { id, event, data } events. */
export function parseSse(text: string): Array<{ id: number | null; event: string; data: any }> {
  const out: Array<{ id: number | null; event: string; data: any }> = []
  for (const block of text.split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue
    let id: number | null = null
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    out.push({ id, event, data: data ? JSON.parse(data) : null })
  }
  return out
}
