/**
 * Images in GigaChat (SPEC §5.3, §9.1): upload to /files → attachments, one image
 * per message, files deleted at the end of the run, MIME types per provider.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'
import { createEngine } from '../src/app.js'
import { gigachatTransport, resetGigachatTokenCache } from '../src/providers/gigachat.js'
import { collectImageUrls, toGigachatRequest } from '../src/providers/gigachat-translate.js'
import {
  bearer,
  finish,
  mockFactory,
  mockModel,
  runRequest,
  START,
  streamFrom,
  textChunks,
  testConfig,
  waitFor,
} from './helpers.js'

const BASE = 'https://gigachat.devices.sberbank.ru/api/v1'
const PNG_BYTES = Buffer.from('png-bytes')
const PNG = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
const JPG = `data:image/jpeg;base64,${Buffer.from('jpg-bytes').toString('base64')}`
const WEBP = `data:image/webp;base64,${Buffer.from('webp-bytes').toString('base64')}`

const text = (t: string) => ({ type: 'text', text: t })
const image = (url: string) => ({ type: 'image_url', image_url: { url } })
const FILE_IDS = new Map([
  [PNG, 'file-png'],
  [JPG, 'file-jpg'],
])

describe('translator: images → attachments (SPEC §9.1)', () => {
  it('text + image → a content string and attachments', () => {
    const out = toGigachatRequest(
      { messages: [{ role: 'user', content: [text("What's in the screenshot?"), image(PNG)] }] },
      FILE_IDS,
    )
    expect(out.messages).toEqual([{ role: 'user', content: "What's in the screenshot?", attachments: ['file-png'] }])
  })

  it('two images → two consecutive user messages, part order preserved', () => {
    const out = toGigachatRequest(
      { messages: [{ role: 'user', content: [text('Compare'), image(PNG), image(JPG)] }] },
      FILE_IDS,
    )
    expect(out.messages).toEqual([
      { role: 'user', content: 'Compare', attachments: ['file-png'] },
      { role: 'user', content: '', attachments: ['file-jpg'] },
    ])
  })

  it('an image without text → empty content', () => {
    const out = toGigachatRequest({ messages: [{ role: 'user', content: [image(JPG)] }] }, FILE_IDS)
    expect(out.messages).toEqual([{ role: 'user', content: '', attachments: ['file-jpg'] }])
  })

  it('several text parts without images are joined into one string', () => {
    const out = toGigachatRequest({
      messages: [{ role: 'user', content: [text('[event x] {}'), text('hello')] }],
    })
    expect(out.messages).toEqual([{ role: 'user', content: '[event x] {}\n\nhello' }])
  })

  it('an image without a file id is an error, not a silent skip', () => {
    expect(() => toGigachatRequest({ messages: [{ role: 'user', content: [image(PNG)] }] })).toThrow(/not uploaded/)
  })

  it('collectImageUrls: user messages only, no duplicates', () => {
    const urls = collectImageUrls({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [image(PNG), text('a')] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [image(PNG), image(JPG)] },
      ],
    })
    expect(urls).toEqual([PNG, JPG])
  })
})

/** GigaChat API mock: OAuth, /files, /files/{id}/delete, chat/completions (SSE). */
function gigachatMock(opts: { upload?: (n: number) => Response | undefined } = {}) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = []
  let uploads = 0
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body })
    if (url.includes('oauth')) return Response.json({ access_token: 't', expires_at: Date.now() + 30 * 60_000 })
    if (url.endsWith('/files')) {
      uploads++
      return opts.upload?.(uploads) ?? Response.json({ id: `file-${uploads}`, object: 'file' })
    }
    if (url.endsWith('/delete')) return Response.json({ deleted: true })
    const chunk = {
      choices: [{ delta: { role: 'assistant', content: 'ok' }, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const byPath = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix))
  return {
    impl,
    calls,
    uploads: () => byPath('/files'),
    deletes: () => byPath('/delete').map((c) => c.url),
    chats: () => byPath('/chat/completions').map((c) => JSON.parse(String(c.body)) as Record<string, any>),
  }
}

describe('GigaChat transport: /files and attachments (SPEC §5.3)', () => {
  beforeEach(() => resetGigachatTokenCache())

  it('the SDK sends an image, GigaChat gets attachments; the file is uploaded once per run and deleted at the end', async () => {
    const m = gigachatMock()
    const transport = gigachatTransport('KEY', 'GIGACHAT_API_PERS', m.impl)
    const model = createOpenAICompatible({ name: 'gigachat', baseURL: BASE, fetch: transport.fetch })('GigaChat-2-Pro')
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: "What's in the screenshot?" },
          { type: 'image' as const, image: new Uint8Array(PNG_BYTES), mediaType: 'image/png' },
        ],
      },
    ]

    // two steps of one run: the same image in the history
    for (let i = 0; i < 2; i++) {
      const result = streamText({ model, maxRetries: 0, messages })
      expect(await result.text).toBe('ok')
    }

    expect(m.uploads()).toHaveLength(1)
    for (const chat of m.chats()) {
      expect(chat.messages).toEqual([{ role: 'user', content: "What's in the screenshot?", attachments: ['file-1'] }])
    }

    const upload = m.uploads()[0]!
    expect(upload.headers.get('authorization')).toBe('Bearer t')
    expect(upload.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    const raw = Buffer.from(upload.body as Uint8Array).toString('latin1')
    expect(raw).toContain('name="purpose"\r\n\r\ngeneral')
    expect(raw).toContain('filename="image.png"\r\nContent-Type: image/png')
    expect(raw).toContain('png-bytes')

    await transport.release('run_1')
    expect(m.deletes()).toEqual([`${BASE}/files/file-1/delete`])
    await transport.release('run_1')
    expect(m.deletes()).toHaveLength(1)
  })

  it('a /files rejection is returned as is, chat is not called; the failure is not cached', async () => {
    const m = gigachatMock({
      upload: (n) =>
        n === 1 ? new Response('{"status":400,"message":"File format is not supported"}', { status: 400 }) : undefined,
    })
    const transport = gigachatTransport('KEY', 'GIGACHAT_API_PERS', m.impl)
    const body = JSON.stringify({ messages: [{ role: 'user', content: [image(PNG)] }] })

    const first = await transport.fetch(`${BASE}/chat/completions`, { method: 'POST', body })
    expect(first.status).toBe(400)
    expect(await first.text()).toContain('File format is not supported')
    expect(m.chats()).toHaveLength(0)

    const second = await transport.fetch(`${BASE}/chat/completions`, { method: 'POST', body })
    expect(second.status).toBe(200)
    expect(m.uploads()).toHaveLength(2)
    expect(m.chats()[0]!.messages[0].attachments).toEqual(['file-2'])

    await transport.release('run_1')
    expect(m.deletes()).toEqual([`${BASE}/files/file-2/delete`])
  })

  it('401 on upload: the token is reset and retried once', async () => {
    const m = gigachatMock({ upload: (n) => (n === 1 ? new Response('', { status: 401 }) : undefined) })
    const transport = gigachatTransport('KEY', 'GIGACHAT_API_PERS', m.impl)
    const res = await transport.fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: [image(JPG)] }] }),
    })
    expect(res.status).toBe(200)
    expect(m.uploads()).toHaveLength(2)
    expect(m.calls.filter((c) => c.url.includes('oauth'))).toHaveLength(2)
  })

  it('without images /files is untouched and release deletes nothing', async () => {
    const m = gigachatMock()
    const transport = gigachatTransport('KEY', 'GIGACHAT_API_PERS', m.impl)
    await transport.fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    })
    await transport.release('run_1')
    expect(m.uploads()).toHaveLength(0)
    expect(m.deletes()).toHaveLength(0)
  })
})

describe('images and the run (SPEC §5.3)', () => {
  const gigachatLlm = { provider: 'gigachat', model: 'GigaChat-2-Pro', api_key: 'KEY' }

  it('GigaChat: webp / gif → 400 unsupported_media_type at validation, png passes', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))
    const engine = createEngine(testConfig(), { modelFactory: mockFactory(model, { providerId: 'gigachat' }) })
    const post = (url: string) =>
      engine.app.request('/runs', {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify(
          runRequest({
            llm: gigachatLlm as never,
            messages: [{ role: 'user', content: [{ type: 'image', url }] }] as never,
          }),
        ),
      })

    for (const url of [WEBP, `data:image/gif;base64,${Buffer.from('gif').toString('base64')}`]) {
      const res = await post(url)
      expect(res.status).toBe(400)
      const error = ((await res.json()) as any).error
      expect(error.code).toBe('unsupported_media_type')
      expect(error.message).toContain('image/png, image/jpeg')
    }
    expect((await post(PNG)).status).toBe(200)
    await engine.shutdown()
  })

  it('Anthropic: webp passes', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))
    const engine = createEngine(testConfig(), { modelFactory: mockFactory(model) })
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(
        runRequest({ messages: [{ role: 'user', content: [{ type: 'image', url: WEBP }] }] as never }),
      ),
    })
    expect(res.status).toBe(200)
    await engine.shutdown()
  })

  it('the runner calls the provider release with run_id after the terminal status', async () => {
    const released: string[] = []
    const model = mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))
    const engine = createEngine(testConfig(), {
      modelFactory: mockFactory(model, {
        release: async (runId) => {
          released.push(runId)
        },
      }),
    })
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest()),
    })
    const body = (await res.json()) as { run_id: string; status: string }
    expect(body.status).toBe('completed')
    await waitFor(() => released.length === 1)
    expect(released).toEqual([body.run_id])
    await engine.shutdown()
  })

  it('shutdown waits for file deletion instead of cutting it off', async () => {
    let deleted = false
    const model = mockModel(async () => streamFrom([START, ...textChunks('ok'), finish('stop')]))
    const engine = createEngine(testConfig(), {
      modelFactory: mockFactory(model, {
        release: async () => {
          await new Promise((r) => setTimeout(r, 200))
          deleted = true
        },
      }),
    })
    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest()),
    })
    expect(res.status).toBe(200)
    await engine.shutdown()
    expect(deleted).toBe(true)
  })
})
