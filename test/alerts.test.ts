/** Error webhook (SPEC §12.3). */
import { afterEach, describe, expect, it } from 'vitest'
import { configureAlerts, sendAlert } from '../src/alerts.js'
import { createEngine, type Engine } from '../src/app.js'
import type { EgressClient, EgressRequest } from '../src/egress/client.js'
import { GigachatOAuthError } from '../src/providers/gigachat.js'
import { bearer, json, mockFactory, mockModel, runRequest, startServer, testConfig, waitFor } from './helpers.js'

const engines: Engine[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  configureAlerts(null)
  for (const e of engines.splice(0)) await e.shutdown()
  for (const s of servers.splice(0)) await s.close()
})

function fakeEgress(sent: EgressRequest[], status = 200): EgressClient {
  return {
    request: async (req: EgressRequest) => {
      sent.push(req)
      return { status, headers: {}, text: '', bytes: new Uint8Array() }
    },
  } as unknown as EgressClient
}

describe('error webhook (SPEC §12.3)', () => {
  it('a failed run sends run_failed with the secret, without the provider body or message content', async () => {
    const hook = await startServer((_b, _r, res) => json(res, 200, { ok: true }))
    servers.push(hook)
    const model = mockModel(async () => {
      throw new GigachatOAuthError(400, 'GIGACHAT_API_PERS', 'scope mismatch')
    })
    const engine = createEngine(
      testConfig({ ERROR_WEBHOOK_URL: `${hook.url}/alerts?sessionID=s1`, CALLBACK_SECRET: 'env-secret' }),
      { modelFactory: mockFactory(model) },
    )
    engines.push(engine)

    const res = await engine.app.request('/runs', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ ...runRequest({ meta: { session_id: 'sess_alert' } as never }), wait: true }),
    })
    const result = (await res.json()) as { run_id: string; status: string }
    expect(result.status).toBe('failed')

    await waitFor(() => hook.requests.length > 0)
    const alert = hook.requests[0]!
    expect(alert.headers['x-engine-secret']).toBe('env-secret')
    expect(alert.body).toMatchObject({
      contract_version: '1',
      event: 'run_failed',
      run_id: result.run_id,
      session_id: 'sess_alert',
      status: 'failed',
      error: { code: 'provider_auth', retriable: false, provider_status: 400 },
    })
    const raw = JSON.stringify(alert.body)
    expect(raw).not.toContain('provider_body')
    expect(raw).not.toContain(JSON.stringify(runRequest().messages).slice(1, -1))
  })

  it('ERROR_WEBHOOK_URL not set: nothing is sent', () => {
    const sent: EgressRequest[] = []
    configureAlerts(null)
    sendAlert('run_failed', { run_id: 'run_1' })
    expect(sent).toHaveLength(0)
  })

  it('a cap of 30 events per minute: an error storm does not become a request storm', () => {
    const sent: EgressRequest[] = []
    configureAlerts({ url: 'https://hooks.example.com/a', secret: undefined, egress: fakeEgress(sent), version: 't' })
    for (let i = 0; i < 100; i++) sendAlert('run_failed', { run_id: `run_${i}` })
    expect(sent).toHaveLength(30)
    expect(sent[0]!.purpose).toBe('error_webhook')
    expect(sent[0]!.headers).toEqual({})
  })

  it('a failure of the webhook itself does not throw', async () => {
    const egress = { request: async () => Promise.reject(new Error('ECONNREFUSED')) } as unknown as EgressClient
    configureAlerts({ url: 'https://hooks.example.com/a', secret: 's', egress, version: 't' })
    expect(() => sendAlert('callback_failed', { run_id: 'run_1' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
})
