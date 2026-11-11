/**
 * Entry point (SPEC §14): env → engine → HTTP on PORT, SIGTERM → graceful
 * shutdown. Routes and all logic live in app.ts, so e2e tests can drive app.request
 * without a socket.
 */
import { classList } from './log-policy.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createEngine } from './app.js'
import { createConfig, describeEndpoints, describeOverrides, describeProxies } from './config.js'
import { log } from './log.js'

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const config = createConfig()
// createEngine initializes the logger from config
const engine = createEngine(config, {}, readVersion())

const server = serve({ fetch: engine.app.fetch, port: config.port }, (info) => {
  log.info('engine_listening', {
    port: info.port,
    public_url: config.publicUrl,
    version: engine.version,
    provider_proxies: describeProxies(config),
    locale: config.engineLocale,
    default_timezone: config.defaultTimezone,
    private_cidrs: config.egressPrivateCidrs.map((c) => c.text),
    http_hosts: config.egressHttpHosts,
    public_providers: config.egressPublicProviders,
    provider_overrides: describeOverrides(config),
    endpoints: describeEndpoints(config),
    content_classes: classList(config.logContent),
    metrics: Boolean(config.metricsToken),
  })
  // a local server cuts a long prompt silently: the engine must trim first (SPEC §9.1)
  for (const ep of Object.values(config.endpoints)) {
    if (ep.contextWindow == null) log.warn('endpoint_context_default', { endpoint: ep.name, context_window: config.maxContextFallback })
  }
})

let stopping = false
async function onSignal(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info('signal', { signal })
  await engine.shutdown()
  server.close()
  // exit naturally once the event loop drains — so the tail of the logs is not lost;
  // a safety net in case of hung sockets
  process.exitCode = 0
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => void onSignal('SIGTERM'))
process.on('SIGINT', () => void onSignal('SIGINT'))
