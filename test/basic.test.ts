import { describe, expect, it } from 'vitest'
import { createEngine } from '../src/app.js'
import { bearer, finish, mockFactory, mockModel, runRequest, START, streamFrom, textChunks, testConfig } from './helpers.js'

describe('basic run without tools (SPEC §13.2)', () => {
  it('a simple run without tools reaches completed', async () => {
    const model = mockModel(async () => streamFrom([START, ...textChunks('Hello!'), finish('stop')]))
    const engine = createEngine(testConfig(), { modelFactory: mockFactory(model) })

    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify(runRequest()),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.status).toBe('completed')
    expect(body.finish_reason).toBe('end_turn')
    expect(body.messages[0].content[0].text).toBe('Hello!')
    await engine.shutdown()
  })
})
