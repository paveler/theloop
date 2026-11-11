/**
 * Prometheus metrics (SPEC §4.10): in-process counters, gauges and histograms rendered as the
 * text exposition format by GET /metrics.
 *
 * Label cardinality is bounded by construction: provider ids and endpoint names are an
 * operator-defined set, purposes and reasons are enums, and the request-controlled `model`
 * label gets its own value only for the first METRICS_MAX_MODELS distinct models — the rest
 * are `other`. No key hashes, meta, session, run, tenant or tool-name labels.
 */

type Labels = Record<string, string>

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]

interface Histogram {
  buckets: number[]
  counts: number[]
  sum: number
  count: number
}

interface Family {
  type: 'counter' | 'histogram'
  help: string
  series: Map<string, { labels: Labels; value: number; hist?: Histogram }>
}

export interface MetricsGauges {
  runsActive: () => number
  runsRetained: () => number
  queues: () => Array<{ provider: string; active: number; queued: number }>
  journal: () => { memoryBytes: number; memoryDropped: number; diskBytes: number | null }
}

const families = new Map<string, Family>()
let maxModels = 50
const models = new Set<string>()
let gauges: MetricsGauges | null = null

export function configureMetrics(settings: { maxModels: number; gauges: MetricsGauges | null }): void {
  families.clear()
  models.clear()
  maxModels = settings.maxModels
  gauges = settings.gauges
}

/** The model label: own value for the first METRICS_MAX_MODELS models, then `other`. */
function modelLabel(model: string): string {
  if (models.has(model)) return model
  if (models.size < maxModels) {
    models.add(model)
    return model
  }
  return 'other'
}

function family(name: string, type: Family['type'], help: string): Family {
  let f = families.get(name)
  if (!f) {
    f = { type, help, series: new Map() }
    families.set(name, f)
  }
  return f
}

function key(labels: Labels): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

function inc(name: string, help: string, labels: Labels, by = 1): void {
  const f = family(name, 'counter', help)
  const k = key(labels)
  const s = f.series.get(k)
  if (s) s.value += by
  else f.series.set(k, { labels, value: by })
}

function observe(name: string, help: string, labels: Labels, value: number): void {
  const f = family(name, 'histogram', help)
  const k = key(labels)
  let s = f.series.get(k)
  if (!s) {
    s = {
      labels,
      value: 0,
      hist: { buckets: DURATION_BUCKETS, counts: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 },
    }
    f.series.set(k, s)
  }
  const h = s.hist!
  h.buckets.forEach((b, i) => {
    if (value <= b) h.counts[i]!++
  })
  h.sum += value
  h.count++
}

/* ----------------------------------------------------------------- events */

export function countRunStarted(): void {
  inc('theloop_runs_started_total', 'Runs accepted by POST /runs.', {})
}

export function countRunFinished(status: string, finishReason: string): void {
  inc('theloop_runs_finished_total', 'Runs that reached a terminal status.', { status, finish_reason: finishReason })
}

export function statusClass(status: number | null | undefined, network: boolean): string {
  if (network || status == null) return 'network'
  if (status === 429) return '429'
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  return '2xx'
}

export function countProviderAttempt(a: {
  provider: string
  model: string
  outcome: 'ok' | 'failed' | 'unknown'
  statusClass: string
  durationMs: number
  ttftMs?: number | null
}): void {
  const model = modelLabel(a.model)
  inc('theloop_provider_attempts_total', 'Provider attempts (SPEC §8).', {
    provider: a.provider,
    model,
    outcome: a.outcome,
    status_class: a.statusClass,
  })
  observe('theloop_provider_attempt_duration_seconds', 'Provider attempt duration.', { provider: a.provider, model }, a.durationMs / 1000)
  if (a.ttftMs != null) {
    observe('theloop_provider_ttft_seconds', 'Time to the first content event.', { provider: a.provider, model }, a.ttftMs / 1000)
  }
}

export function countTokens(provider: string, model: string, tokens: Record<'input' | 'output' | 'cache_read' | 'cache_write', number>): void {
  const label = modelLabel(model)
  for (const [kind, n] of Object.entries(tokens)) {
    if (n > 0) inc('theloop_tokens_total', 'Tokens by kind.', { provider, model: label, kind }, n)
  }
}

export function observeQueueWait(provider: string, waitMs: number): void {
  observe('theloop_provider_queue_wait_seconds', 'Wait for a provider queue slot (SPEC §11.6).', { provider }, waitMs / 1000)
}

export function countLlmFallback(from: string, to: string): void {
  inc('theloop_llm_fallbacks_total', 'Switches to a later llm entry (SPEC §9.5).', { from_provider: from, to_provider: to })
}

export function countToolCall(outcome: string, durationMs: number): void {
  inc('theloop_tool_calls_total', 'Tool calls by outcome.', { outcome })
  observe('theloop_tool_call_duration_seconds', 'Tool call duration.', {}, durationMs / 1000)
}

export function countCallback(outcome: 'sent' | 'failed'): void {
  inc('theloop_callback_deliveries_total', 'Callback delivery outcomes (SPEC §7).', { outcome })
}

export function countEgressDenied(purpose: string, reason: string): void {
  inc('theloop_egress_denied_total', 'Egress refusals (SPEC §11.4).', { purpose, reason })
}

/* ----------------------------------------------------------------- render */

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labelText(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra }
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escape(v)}"`)
  return parts.length > 0 ? `{${parts.join(',')}}` : ''
}

function gauge(lines: string[], name: string, help: string, rows: Array<{ labels: Labels; value: number }>): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
  for (const row of rows) lines.push(`${name}${labelText(row.labels)} ${row.value}`)
}

export function renderMetrics(): string {
  const lines: string[] = []
  for (const [name, f] of [...families.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`)
    for (const s of f.series.values()) {
      if (f.type === 'counter') {
        lines.push(`${name}${labelText(s.labels)} ${s.value}`)
        continue
      }
      const h = s.hist!
      h.buckets.forEach((b, i) => lines.push(`${name}_bucket${labelText(s.labels, { le: String(b) })} ${h.counts[i]}`))
      lines.push(`${name}_bucket${labelText(s.labels, { le: '+Inf' })} ${h.count}`)
      lines.push(`${name}_sum${labelText(s.labels)} ${h.sum}`)
      lines.push(`${name}_count${labelText(s.labels)} ${h.count}`)
    }
  }
  if (gauges) {
    gauge(lines, 'theloop_runs_active', 'Runs running or cancelling.', [{ labels: {}, value: gauges.runsActive() }])
    gauge(lines, 'theloop_runs_retained', 'Finished runs kept for GET.', [{ labels: {}, value: gauges.runsRetained() }])
    const byProvider = new Map<string, { active: number; queued: number }>()
    for (const q of gauges.queues()) {
      const row = byProvider.get(q.provider) ?? { active: 0, queued: 0 }
      row.active += q.active
      row.queued += q.queued
      byProvider.set(q.provider, row)
    }
    gauge(
      lines,
      'theloop_provider_queue_active',
      'Provider slots in use, summed over keys (SPEC §11.6).',
      [...byProvider].map(([provider, r]) => ({ labels: { provider }, value: r.active })),
    )
    gauge(
      lines,
      'theloop_provider_queue_depth',
      'Attempts waiting for a provider slot, summed over keys.',
      [...byProvider].map(([provider, r]) => ({ labels: { provider }, value: r.queued })),
    )
    const j = gauges.journal()
    gauge(lines, 'theloop_journal_bytes', 'Journal size (SPEC §12.4).', [
      { labels: { store: 'memory' }, value: j.memoryBytes },
      ...(j.diskBytes != null ? [{ labels: { store: 'disk' }, value: j.diskBytes }] : []),
    ])
    lines.push(
      '# HELP theloop_journal_dropped_total Entries evicted from the memory journal.',
      '# TYPE theloop_journal_dropped_total counter',
      `theloop_journal_dropped_total{store="memory"} ${j.memoryDropped}`,
    )
  }
  return `${lines.join('\n')}\n`
}
