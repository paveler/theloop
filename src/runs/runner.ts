/**
 * The agent loop, driven STEP BY STEP MANUALLY (SPEC §11.3, §14).
 *
 * streamText for one step → finish-step → collect tool calls → §10.1 limits →
 * execution → next step. The SDK loop (stopWhen / execute in a tool) is not used:
 * we need control over attempt retries, budgets and the MOMENT tools run — a broken
 * stream must not leave a half-executed batch.
 */
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { Config } from '../config.js'
import {
  BUILTIN_TOOLS,
  CONTRACT_VERSION,
  publicError,
  type AssistantMessage,
  type AssistantPart,
  type Limits,
  type OutputCheckFailReason,
  type OutputCheckResult,
  type RunContext,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type StoredMessage,
  type ToolCallStatus,
  type ToolCallSummary,
  type ToolDef,
  type UsageCall,
} from '../contracts.js'
import type { EgressClient } from '../egress/client.js'
import { EngineError, type ErrorCode } from '../errors.js'
import { resolveLocale, texts, type Texts } from '../i18n.js'
import { sendAlert } from '../alerts.js'
import { sha256 } from '../ids.js'
import { log, safeUrl } from '../log.js'
import type { ResolvedModel } from '../providers/factory.js'
import {
  rateLimitBackoff,
  throttleLabel,
  type AcquireResult,
  type ProviderThrottle,
  type SlotOutcome,
} from '../providers/throttle.js'
import { deliverCallback } from './callback.js'
import { createImageResolver } from './images.js'
import {
  buildSystemMessages,
  describeMessage,
  engineDateLine,
  estimateMessageTokens,
  estimateTokens,
  estimateToolSchemaTokens,
  isEmptyToolResult,
  toModelMessages,
  trimHistory,
} from './messages.js'
import type { RunRecord, RunRegistry } from './registry.js'
import {
  appendBlock,
  checkText,
  ISSUE_MISSING,
  issueLines,
  issuePaths,
  repairPrompt,
  stripBlocks,
  type CompiledOutputCheck,
  type Issue,
} from './output-checks.js'
import { streamStep, type StepOutcome, type StepToolCall } from './provider.js'
import { SkillState, type ModelTool, type Restored } from './skills.js'
import { validateToolArgs } from '../tools/args.js'
import { callTool, type ToolOutcome } from '../tools/http.js'
import { checkBudgets, normalizeUsage, UsageTracker } from './usage.js'

/** Network / 5xx: ×2 (SPEC §11.3). 429 has its own ladder: Retry-After or full jitter, up to PROVIDER_RATE_LIMIT_RETRIES. */
const PROVIDER_RETRY_DELAYS_MS = [1000, 3000]

/** How many repeats of the same call are forgiven before tools are disabled (SPEC §6.7). */
const MAX_REPEATED_CALLS = 1

/** This many empty results from one tool in a run, and tools are disabled (SPEC §6.7). */
const MAX_EMPTY_RESULTS = 2

/** How many trailing history messages to show in run_start (SPEC §12.4). */
const HISTORY_TAIL_IN_LOG = 6

/**
 * Repair-step deltas go to SSE as a continuation of the same answer (SPEC §5.4): without
 * a separator, the closing "```" of the old block would glue onto the "```action-card" of the new one.
 */
const REPAIR_SEPARATOR = '\n\n'

export interface RunnerDeps {
  config: Config
  egress: EgressClient
  registry: RunRegistry
  /** Engine stop signal — switches callback delivery (SPEC §11.1). */
  stopping: AbortSignal
  /** Queue and AIMD ceiling per provider key (SPEC §11.6). */
  throttle: ProviderThrottle
}

export interface RunPlan {
  request: RunRequest
  resolved: ResolvedModel
  limits: Limits
  /** Format gate for the final answer (SPEC §5.4); [] — no checks, the loop as before. */
  outputChecks: CompiledOutputCheck[]
}

type RepairOutcome =
  | { ok: true; attempts: number; raw: string }
  | { ok: false; attempts: number; reason: OutputCheckFailReason; issues: Issue[] }

/** Starts the loop; the terminal state is observed via record.terminal. */
export function startRun(record: RunRecord, plan: RunPlan, deps: RunnerDeps): Promise<void> {
  const execution = new RunExecution(record, plan, deps)
  return execution.execute()
}

class RunExecution {
  private readonly usage: UsageTracker
  private readonly toolsByName = new Map<string, ToolDef>()
  /** The step's tool set; rebuilt when an activation changes it (SPEC §6.8). */
  private toolSet: ToolSet = {}
  private toolSetVersion = -1
  private readonly resolveImage: (url: string) => Promise<{ data: Uint8Array; mediaType: string }>
  /** `system` with the skill index (SPEC §6.8). */
  private readonly systemText: string | null
  private readonly systemTokens: number
  /** Schemas of the visible tools only: deferred tools cost nothing until activated. */
  private toolTokens = 0
  private readonly cacheEnabled: boolean
  private readonly skills: SkillState
  private readonly restored: Restored

  private seq = 0
  private newMessages: StoredMessage[] = []
  private toolSummaries: ToolCallSummary[] = []
  private contextTrimmed = false
  /** The last main-step attempt with tokens and how many new messages preceded it — the base for result.context. */
  private contextBase: { call: UsageCall; messagesBefore: number } | null = null
  private steps = 0
  private toolCallsUsed = 0
  private cacheCreated = false
  /** tool + args keys of calls from previous steps — the loop detector (SPEC §6.7). */
  private readonly seenCalls = new Set<string>()
  private repeatedCalls = 0
  /** tool → how many times in the run it returned an empty result. */
  private readonly emptyResults = new Map<string, number>()
  /** The model is repeating itself — the following steps run with toolChoice: 'none'. */
  private toolsDisabled = false
  /** Format gate results per fence (SPEC §5.4). */
  private outputCheckResults: OutputCheckResult[] = []
  /** A repair step is in progress — for journal fields. */
  private repairing: { fence: string; attempt: number } | null = null
  /** Which budget blocked the repair step. */
  private repairBudgetLimit: 'max_total_tokens' | 'max_cost' | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  /** When limits.timeout_ms fires — waiting for a slot and the 429 retry pause must fit before it. */
  private deadline = Number.POSITIVE_INFINITY
  /** Total wait for provider slots across all attempts (SPEC §11.6). */
  private queueWaitMs = 0
  private finished = false
  private released = false

  constructor(
    private readonly record: RunRecord,
    private readonly plan: RunPlan,
    private readonly deps: RunnerDeps,
  ) {
    this.usage = new UsageTracker(plan.request.llm.pricing)
    record.liveUsage = () => this.usage.snapshot()

    for (const def of plan.request.tools) this.toolsByName.set(def.name, def)

    this.cacheEnabled = plan.resolved.supportsCacheControl && plan.request.llm.params.cache !== false
    // engine text locale (SPEC Appendix B) — before anything that writes text for the model
    const locale = resolveLocale(plan.request.meta.locale, deps.config.engineLocale)
    if (locale.unsupported) {
      log.warn('locale_unsupported', { run_id: record.runId, requested: locale.unsupported, locale: locale.locale })
    }
    this.texts = texts(locale.locale)
    this.skills = new SkillState(plan.request, plan.resolved.toolReferences, this.texts)
    this.restored = this.skills.restore(plan.request.messages)
    this.refreshTools()
    const index = this.skills.index()
    const system = plan.request.system && plan.request.system.trim().length > 0 ? plan.request.system : null
    this.systemText = index ? (system ? `${system}\n\n${index}` : index) : (plan.request.system ?? null)
    this.resolveImage = createImageResolver(
      deps.egress,
      deps.config,
      record.abort.signal,
      plan.resolved.providerId,
      this.texts,
    )

    const timezone =
      typeof plan.request.meta.timezone === 'string' && plan.request.meta.timezone
        ? plan.request.meta.timezone
        : deps.config.defaultTimezone
    this.timezone = timezone
    this.dateLine = engineDateLine(timezone, new Date(), this.texts)
    this.dateAnchor = plan.request.messages.findLast((m) => m.role === 'user') ?? null
    this.systemTokens = estimateTokens(this.systemText ?? '') + estimateTokens(this.dateLine)

    // GigaChat's cache lives in a session (SPEC §9.1): all steps and chat turns go into one. Hashed so
    // the client's id never reaches the provider and the header does not break on non-ASCII
    const sessionHeader = plan.resolved.sessionHeader
    this.providerHeaders = sessionHeader
      ? { [sessionHeader]: sha256(record.sessionId ?? record.runId).slice(0, 32) }
      : undefined
  }

  private readonly timezone: string
  /** Engine texts in the run's locale (SPEC Appendix B). */
  private readonly texts: Texts
  /** The current time — one per run (SPEC §9.4). */
  private readonly dateLine: string
  /** The request's last user message: without created_at, the current time goes at its end (SPEC §9.4). */
  private readonly dateAnchor: StoredMessage | null
  private readonly providerHeaders: Record<string, string> | undefined

  /**
   * The tool set and its token estimate, rebuilt only when the visible set changed. Tools go
   * by name, not in request order (SPEC §9.3): Anthropic and GLM put them at the start of the
   * prompt, and reordering them from turn to turn wipes the whole cache.
   */
  private refreshTools(): void {
    if (this.toolSetVersion === this.skills.version) return
    this.toolSetVersion = this.skills.version
    this.toolSet = buildToolSet(this.skills.providerTools(this.plan.request.tools), this.cacheEnabled)
    this.toolTokens = estimateToolSchemaTokens(this.skills.visibleTools(this.plan.request.tools))
  }

  async execute(): Promise<void> {
    const { record, plan, deps } = this
    const { request } = plan
    const roles = { user: 0, assistant: 0, tool: 0 }
    for (const message of request.messages) roles[message.role]++
    log.info(
      'run_start',
      {
        run_id: record.runId,
        session_id: record.sessionId,
        provider: plan.resolved.providerId,
        model: request.llm.model,
        idempotency_key: request.idempotency_key ?? null,
        history_revision: request.history_revision ?? null,
        wait: request.wait,
        callback: request.callback ? safeUrl(request.callback.url) : null,
        tools: request.tools.map((t) => `${t.name}:${t.effect}${t.defer_loading === true ? ':deferred' : ''}`),
        ...(this.skills.enabled
          ? { skills: this.skills.skillNames(), activation: this.skills.mechanism, tool_search: this.skills.toolSearch }
          : {}),
        limits: plan.limits,
        context_window: plan.resolved.contextWindow,
        cache: this.cacheEnabled,
        history: { messages: request.messages.length, ...roles },
        meta: request.meta,
        ...(plan.outputChecks.length > 0
          ? { output_checks: plan.outputChecks.map((c) => `${c.fence}:${c.maxRepairs}`) }
          : {}),
      },
      {
        system: this.systemText,
        history_tail: request.messages.slice(-HISTORY_TAIL_IN_LOG).map(describeMessage),
      },
    )

    for (const item of this.restored.invalid) {
      log.warn('builtin_history_invalid', { run_id: record.runId, call_id: item.call_id, tool: item.tool })
    }
    if (this.restored.skills.length > 0 || this.restored.tools.length > 0) {
      log.info('skills_restored', { run_id: record.runId, skills: this.restored.skills, tools: this.restored.tools })
    }

    record.sse.emit('start', {
      run_id: record.runId,
      provider: plan.resolved.providerId,
      model: plan.request.llm.model,
    })

    this.deadline = Date.now() + plan.limits.timeout_ms
    this.timeoutTimer = setTimeout(() => {
      if (!this.finished) {
        log.warn('run_timeout', { run_id: record.runId, step: this.steps, timeout_ms: plan.limits.timeout_ms })
        record.abortReason = 'run_timeout'
        record.abort.abort(new Error('run_timeout'))
      }
    }, plan.limits.timeout_ms)
    if (typeof this.timeoutTimer.unref === 'function') this.timeoutTimer.unref()

    try {
      await this.loop()
    } catch (err) {
      if (!this.finished) {
        const engineError = err instanceof EngineError ? err : null
        const code: ErrorCode = engineError?.code ?? 'internal_error'
        log.error('run_failed', {
          run_id: record.runId,
          step: this.steps,
          err: String(err),
          ...(engineError ? {} : { stack: err instanceof Error ? err.stack : undefined }),
        })
        this.sealUnresolvedToolCalls('not_executed: failed', 'not_executed')
        this.finish('failed', code, {
          code,
          message: engineError?.message ?? this.texts.internalError,
          retriable: engineError?.retriable ?? false,
        })
      }
    } finally {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
      if (!this.finished) {
        // safety net: the terminal state must be reached, or cancel and wait: true would hang
        record.status = 'failed'
        record.resolveTerminal()
      }
      this.releaseProvider()
    }
  }

  /* ------------------------------------------------------------ loop */

  private async loop(): Promise<void> {
    const { limits } = this.plan

    for (let step = 1; ; step++) {
      this.steps = step
      this.record.steps = step

      const prompt = await this.buildPrompt(step)
      const outcome = await this.callProvider(prompt, step)
      if (outcome === 'budget_exceeded') return
      if (outcome === 'aborted') return
      if (outcome === 'failed') return

      const partialByLength = outcome.finishReason === 'length'
      const message = this.pushAssistant(outcome.parts, partialByLength)
      this.emitStepEvent(step, outcome)

      if (outcome.toolCalls.length === 0) {
        if (partialByLength) {
          this.logLimit('max_tokens', { step, max_tokens: limits.max_tokens })
          this.finish('stopped_limit', 'max_tokens')
          return
        }
        // the format gate goes exactly here: otherwise the run would end with the final text (SPEC §5.4)
        if (this.plan.outputChecks.length > 0 && (await this.applyOutputChecks(step, message)) === 'cancelled') {
          this.finishAborted()
          return
        }
        this.finish('completed', 'end_turn')
        return
      }

      // §10.1: step boundaries — tools of the last allowed step are not executed,
      // a batch larger than the remaining max_tool_calls is not executed at all
      if (partialByLength) {
        this.logLimit('max_tokens', { step, max_tokens: limits.max_tokens, pending_tool_calls: outcome.toolCalls.length })
        this.sealUnresolvedToolCalls('not_executed: max_tokens', 'not_executed')
        this.finish('stopped_limit', 'max_tokens')
        return
      }
      if (step >= limits.max_steps) {
        this.logLimit('max_steps', { step, max_steps: limits.max_steps, pending_tool_calls: outcome.toolCalls.length })
        this.sealUnresolvedToolCalls('not_executed: max_steps', 'not_executed')
        this.finish('stopped_limit', 'max_steps')
        return
      }
      // built-ins and tool_not_loaded rejections never reach an endpoint: they do not count (§6.8)
      const remaining = limits.max_tool_calls - this.toolCallsUsed
      const requested = outcome.toolCalls.filter((c) => !this.skills.builtin(c.tool) && !this.skills.isHidden(c.tool)).length
      if (requested > remaining) {
        this.logLimit('max_tool_calls', {
          step,
          used: this.toolCallsUsed,
          requested,
          max_tool_calls: limits.max_tool_calls,
        })
        this.sealUnresolvedToolCalls('not_executed: max_tool_calls', 'not_executed')
        this.finish('stopped_limit', 'max_tool_calls')
        return
      }

      const deferred = await this.executeToolBatch(outcome.toolCalls)

      if (this.record.abort.signal.aborted) {
        this.finishAborted()
        return
      }
      if (deferred) {
        this.finish('awaiting_tool', 'deferred')
        return
      }
    }
  }

  /* ----------------------------------------------------- provider call */

  /** @param extra a tail that is not in the run's messages: repair synthetics and drafts (SPEC §5.4). */
  private async buildPrompt(
    step: number,
    extra: readonly StoredMessage[] = [],
  ): Promise<{ messages: ModelMessage[]; historyTokens: number }> {
    const { plan } = this
    const history = [...plan.request.messages, ...this.newMessages, ...extra]
    this.refreshTools()

    const trim = trimHistory({
      messages: history,
      systemTokens: this.systemTokens,
      toolTokens: this.toolTokens,
      reserveTokens: plan.limits.max_tokens,
      contextWindow: plan.resolved.contextWindow,
      ...(this.skills.enabled ? { pinned: (block) => this.skills.isPinned(block) } : {}),
    })
    if (trim.trimmed) {
      this.contextTrimmed = true
      log.warn('context_trimmed', {
        run_id: this.record.runId,
        step,
        messages_before: history.length,
        messages_after: trim.messages.length,
        estimated_tokens: trim.estimatedTokens,
        context_window: plan.resolved.contextWindow,
      })
    }

    // trimming may have dropped the last user message — then the date goes into system
    const anchor = this.dateAnchor && trim.messages.includes(this.dateAnchor) ? this.dateAnchor : null
    const converted = await toModelMessages(trim.messages, {
      provider: plan.resolved.providerId,
      resolveImage: this.resolveImage,
      dates: { timezone: this.timezone, anchor, now: this.dateLine },
      cacheBreakpoints: this.cacheEnabled,
      texts: this.texts,
      ...(this.skills.enabled ? { renderBuiltin: (message, args) => this.skills.render(message, args) } : {}),
    })
    const system = buildSystemMessages(this.systemText, anchor ? null : this.dateLine, this.cacheEnabled)

    const historyTokens = Math.max(
      0,
      trim.estimatedTokens - this.systemTokens - this.toolTokens - plan.limits.max_tokens,
    )
    log.debug('step_start', {
      run_id: this.record.runId,
      step,
      messages: trim.messages.length,
      new_messages: this.newMessages.length,
      estimated_tokens: trim.estimatedTokens,
      tools_disabled: this.toolsDisabled || undefined,
      tool_calls_used: this.toolCallsUsed,
      ...(this.skills.enabled ? { tools_visible: this.skills.visibleTools(plan.request.tools).map((t) => t.name) } : {}),
      ...this.repairFields(),
    })
    return { messages: [...system, ...converted], historyTokens }
  }

  /**
   * Provider call attempts, retried ONLY before the first content event
   * (SPEC §11.3): after that a transparent retry is impossible — the browser has already seen text.
   *
   * @param repair a block repair step (SPEC §5.4): tool_choice none, deltas go after
   * the separator, tool_call is not sent to SSE; a limit, a broken stream or a provider failure
   * do NOT end the run — the gate decides the outcome, the model's answer already exists.
   */
  private async callProvider(
    prompt: { messages: ModelMessage[]; historyTokens: number },
    step: number,
    repair = false,
  ): Promise<StepOutcome | 'budget_exceeded' | 'aborted' | 'failed'> {
    const { plan, record } = this
    const params = plan.request.llm.params
    let separated = false
    let rateLimitRetries = 0
    let otherRetries = 0

    for (let attempt = 1; ; attempt++) {
      // budgets — before EVERY attempt, including transport retries (SPEC §10.2).
      // With message caching the history is a worst-case cache write: it costs more than plain input
      const cacheable = this.cacheEnabled ? this.systemTokens + this.toolTokens : 0
      const budget = checkBudgets(
        this.usage,
        {
          input: this.cacheEnabled ? 0 : prompt.historyTokens + this.systemTokens + this.toolTokens,
          cacheWrite: (this.cacheEnabled ? prompt.historyTokens : 0) + (this.cacheCreated ? 0 : cacheable),
          cacheRead: this.cacheCreated ? cacheable : 0,
          output: plan.limits.max_tokens,
        },
        plan.limits,
        plan.request.llm.pricing,
      )
      if (!budget.ok) {
        this.logLimit(budget.exceeded!, {
          step,
          attempt,
          spent_tokens: this.usage.spentTokens(),
          max_total_tokens: plan.limits.max_total_tokens,
          ...(plan.limits.max_cost != null
            ? { spent_cost: this.usage.spentCost(), max_cost: plan.limits.max_cost }
            : {}),
          ...this.repairFields(),
        })
        if (repair) {
          this.repairBudgetLimit = budget.exceeded === 'max_cost' ? 'max_cost' : 'max_total_tokens'
          return 'budget_exceeded'
        }
        this.finish('stopped_limit', budget.exceeded!)
        return 'budget_exceeded'
      }

      // a provider slot for every attempt; a retry queues again (SPEC §11.6)
      const ticket = await this.acquireSlot(step, attempt)
      if (ticket.kind !== 'granted') {
        // time ran out in the queue — provider_queue_timeout; cancel / shutdown in the queue
        // and a run aborted before it reached the queue are a plain abort
        const timedOut = isQueueTimeout(ticket, record.abortReason)
        if (repair) return ticket.kind === 'aborted' ? 'aborted' : 'failed'
        if (!timedOut) {
          this.finishAborted()
          return 'aborted'
        }
        this.finish('failed', 'provider_queue_timeout', {
          code: 'provider_queue_timeout',
          message: this.texts.queueTimeout(plan.resolved.providerId, ticket.waitedMs, ticket.queueDepth, ticket.limit),
          retriable: true,
        })
        return 'failed'
      }

      let slotOutcome: SlotOutcome = 'neutral'
      let retryAfterMs: number | undefined
      let outcome: StepOutcome
      // a text-only step: the model is repeating itself (§6.7) or repairing a block (§5.4)
      const noTools = this.toolsDisabled || repair
      try {
        outcome = await streamStep({
          texts: this.texts,
          model: plan.resolved.model,
          provider: plan.resolved.providerId,
          messages: prompt.messages,
          // a provider that calls tools even with none simply does not get them on such steps (SPEC §9.2)
          tools: noTools && !plan.resolved.honorsToolChoiceNone ? {} : this.toolSet,
          ...(noTools ? { toolChoice: 'none' as const } : {}),
          maxTokens: plan.limits.max_tokens,
          // newer Claude models reject sampling params — the factory cleared the flag (SPEC §9.3)
          temperature: plan.resolved.acceptsSampling ? params.temperature : undefined,
          topP: plan.resolved.acceptsSampling ? params.top_p : undefined,
          stopSequences: params.stop,
          seed: params.seed,
          providerOptions: plan.resolved.providerOptions,
          ...(this.providerHeaders ? { headers: this.providerHeaders } : {}),
          abortSignal: record.abort.signal,
          onTextDelta: (text) => {
            if (repair && !separated) {
              separated = true
              record.sse.emit('delta', { text: REPAIR_SEPARATOR })
            }
            record.sse.emit('delta', { text })
          },
          onReasoningDelta: (text) => {
            if (plan.request.stream.expose_reasoning) record.sse.emit('reasoning', { text })
          },
          onToolCall: (call) => {
            // repair runs with tool_choice none; an ignored call will never execute —
            // in SSE it would hang as pending forever
            if (repair) return
            record.sse.emit('tool_call', {
              call_id: call.callId,
              tool: call.tool,
              ...(plan.request.stream.expose_args ? { args: call.args } : {}),
            })
          },
        })
        // AIMD: success raises the ceiling, 429 cuts it; abort, network and 5xx do not count
        if (!outcome.aborted && !outcome.failure) slotOutcome = 'ok'
        else if (!outcome.aborted && outcome.failure?.code === 'provider_rate_limited') {
          slotOutcome = 'rate_limited'
          retryAfterMs = outcome.failure.retryAfterMs
        }
      } finally {
        ticket.slot.release(slotOutcome, { retryAfterMs, runId: record.runId })
      }

      if (outcome.aborted) {
        this.recordAttempt(outcome, 'unknown', prompt.historyTokens, attempt)
        if (repair) return 'aborted'
        this.pushAssistant(outcome.parts, true)
        this.finishAborted()
        return 'aborted'
      }

      if (!outcome.failure) {
        this.recordAttempt(outcome, 'ok', prompt.historyTokens, attempt)
        return outcome
      }

      this.recordAttempt(outcome, outcome.failure.kind, prompt.historyTokens, attempt)
      const rateLimited = outcome.failure.code === 'provider_rate_limited'
      // no retry after the first content event (below); 429 has its own ladder
      const retry =
        outcome.sawContent || !outcome.failure.retriable
          ? { delayMs: null, skipped: undefined }
          : rateLimited
            ? this.rateLimitRetryDelay(rateLimitRetries + 1, outcome.failure.retryAfterMs)
            : otherRetries < PROVIDER_RETRY_DELAYS_MS.length
              ? { delayMs: PROVIDER_RETRY_DELAYS_MS[otherRetries]!, skipped: undefined }
              : { delayMs: null, skipped: 'retries_exhausted' as const }
      const willRetry = retry.delayMs !== null
      log.warn(
        'provider_failure',
        {
          run_id: record.runId,
          step,
          attempt,
          provider: plan.resolved.providerId,
          kind: outcome.failure.kind,
          code: outcome.failure.code,
          message: outcome.failure.message,
          provider_status: outcome.failure.providerStatus,
          retriable: outcome.failure.retriable,
          saw_content: outcome.sawContent,
          retry_in_ms: retry.delayMs,
          retry_after_ms: outcome.failure.retryAfterMs,
          retry_skipped: retry.skipped,
          ...(rateLimited ? { rate_limit_retry: rateLimitRetries } : {}),
          ...this.repairFields(),
        },
        { provider_body: outcome.failure.providerBody, partial_text: outcome.text || undefined },
      )

      // retry is forbidden after the first content event (SPEC §11.3)
      if (outcome.sawContent) {
        if (repair) return 'failed'
        this.pushAssistant(outcome.parts, true)
        this.sealUnresolvedToolCalls('not_executed: stream_interrupted', 'not_executed')
        this.finish('failed', 'provider_stream_interrupted', {
          code: 'provider_stream_interrupted',
          message: outcome.failure.message,
          retriable: true,
          ...(outcome.failure.providerStatus ? { provider_status: outcome.failure.providerStatus } : {}),
          ...(outcome.failure.providerBody ? { provider_body: outcome.failure.providerBody } : {}),
        })
        return 'failed'
      }

      if (willRetry) {
        if (rateLimited) rateLimitRetries++
        else otherRetries++
        await sleep(retry.delayMs!, record.abort.signal)
        if (record.abort.signal.aborted) {
          if (repair) return 'aborted'
          this.finishAborted()
          return 'aborted'
        }
        continue
      }

      if (repair) return 'failed'
      this.finish('failed', outcome.failure.code, {
        code: outcome.failure.code,
        message: outcome.failure.message,
        retriable: outcome.failure.retriable,
        ...(outcome.failure.providerStatus ? { provider_status: outcome.failure.providerStatus } : {}),
        ...(outcome.failure.providerBody ? { provider_body: outcome.failure.providerBody } : {}),
      })
      return 'failed'
    }
  }

  /**
   * Waits for a provider slot (SPEC §11.6): no longer than PROVIDER_QUEUE_TIMEOUT_MS and no
   * longer than the run's remaining timeout_ms. If it had to wait — a provider_queue_wait event.
   */
  private async acquireSlot(step: number, attempt: number): Promise<AcquireResult> {
    const { plan, record, deps } = this
    const remaining = Math.max(0, this.deadline - Date.now())
    const timeoutMs = Math.min(deps.throttle.settings.queueTimeoutMs, remaining)
    const ticket = await deps.throttle.acquire(plan.resolved.throttleKey, record.abort.signal, timeoutMs)
    this.queueWaitMs += ticket.waitedMs
    // queueDepth 0 — never queued: the slot was granted at once or the run was aborted before the queue
    if (ticket.queueDepth > 0) {
      const outcome =
        ticket.kind === 'granted' ? 'granted' : isQueueTimeout(ticket, record.abortReason) ? 'timeout' : 'aborted'
      log[outcome === 'timeout' ? 'warn' : 'info']('provider_queue_wait', {
        run_id: record.runId,
        step,
        attempt,
        provider: plan.resolved.providerId,
        throttle_key: throttleLabel(plan.resolved.throttleKey),
        outcome,
        wait_ms: ticket.waitedMs,
        queue_depth: ticket.queueDepth,
        limit: ticket.limit,
        active: ticket.active,
        queue_timeout_ms: timeoutMs,
        ...this.repairFields(),
      })
    }
    return ticket
  }

  /**
   * Pause before a 429 retry (SPEC §11.3): Retry-After if sent, otherwise full
   * jitter. No retry if attempts are exhausted or the pause does not fit in the run's timeout_ms —
   * an honest provider_rate_limited beats a run_timeout mid-sleep.
   */
  private rateLimitRetryDelay(
    retry: number,
    retryAfterMs: number | undefined,
  ): { delayMs: number | null; skipped: 'retries_exhausted' | 'run_deadline' | undefined } {
    const { config } = this.deps
    if (retry > config.rateLimitRetries) return { delayMs: null, skipped: 'retries_exhausted' }
    const delayMs = retryAfterMs ?? rateLimitBackoff(retry, config.rateLimitBackoffMs, config.rateLimitMaxDelayMs)
    if (Date.now() + delayMs >= this.deadline) return { delayMs: null, skipped: 'run_deadline' }
    return { delayMs, skipped: undefined }
  }

  private recordAttempt(
    outcome: StepOutcome,
    kind: 'ok' | 'failed' | 'unknown',
    historyTokens: number,
    attempt: number,
  ): void {
    const { plan } = this
    const logAttempt = () => {
      const last = this.usage.calls[this.usage.calls.length - 1]
      log.info('provider_attempt', {
        run_id: this.record.runId,
        step: this.steps,
        attempt,
        provider: plan.resolved.providerId,
        model: plan.request.llm.model,
        status: last?.status,
        ...this.repairFields(),
        aborted: outcome.aborted || undefined,
        finish_reason: outcome.finishReason,
        estimated: last?.estimated,
        duration_ms: outcome.durationMs,
        input_tokens: last?.input_tokens,
        output_tokens: last?.output_tokens,
        cache_read_tokens: last?.cache_read_tokens || undefined,
        cache_write_tokens: last?.cache_write_tokens || undefined,
        reasoning_tokens: last?.reasoning_tokens || undefined,
        provider_request_id: outcome.providerRequestId,
      })
    }

    if (kind === 'failed') {
      this.usage.record({
        status: 'failed',
        provider: plan.resolved.providerId,
        model: plan.request.llm.model,
        tokens: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
        finishReason: outcome.finishReason,
        durationMs: outcome.durationMs,
        providerRequestId: outcome.providerRequestId,
        estimated: false,
      })
      logAttempt()
      return
    }

    const reported = normalizeUsage(outcome.usage)
    const hasReported = outcome.usage?.inputTokens != null || outcome.usage?.outputTokens != null

    if (kind === 'ok' && hasReported && plan.resolved.capabilities.usage_in_stream) {
      if (reported.cache_read_tokens > 0 || reported.cache_write_tokens > 0) this.cacheCreated = true
      const call = this.usage.record({
        status: 'ok',
        provider: plan.resolved.providerId,
        model: plan.request.llm.model,
        tokens: reported,
        finishReason: outcome.finishReason,
        durationMs: outcome.durationMs,
        providerRequestId: outcome.providerRequestId,
        estimated: false,
      })
      this.noteContextCall(call)
      logAttempt()
      return
    }

    // the provider did not report usage (§8.2) or the attempt was cut off — count it as an estimate
    const estimatedOutput = estimateTokens(outcome.text) + estimateTokens(outcome.reasoningText)
    const tokens = {
      input_tokens: hasReported ? reported.input_tokens : historyTokens + this.systemTokens + this.toolTokens,
      output_tokens: hasReported ? reported.output_tokens : estimatedOutput,
      cache_read_tokens: reported.cache_read_tokens,
      cache_write_tokens: reported.cache_write_tokens,
      reasoning_tokens: reported.reasoning_tokens,
    }
    const call = this.usage.record({
      status: kind === 'ok' ? 'ok' : 'unknown',
      provider: plan.resolved.providerId,
      model: plan.request.llm.model,
      tokens,
      finishReason: outcome.finishReason,
      durationMs: outcome.durationMs,
      providerRequestId: outcome.providerRequestId,
      estimated: true,
      // a cut-off attempt holds the full max_tokens in the budget (SPEC §10.2.3)
      ...(kind === 'unknown' ? { reservedOutput: plan.limits.max_tokens } : {}),
    })
    this.noteContextCall(call)
    logAttempt()
  }

  /** §5.4 repair steps do not count: their synthetics and drafts never enter the history. */
  private noteContextCall(call: UsageCall): void {
    if (this.repairing) return
    this.contextBase = { call, messagesBefore: this.newMessages.length }
  }

  /**
   * How much context is used after the run (SPEC §7): the full prompt of the last main-step
   * call + its answer + tool messages appended after it. No attempt with tokens —
   * the §5.1 estimate over system, tools and the whole history.
   */
  private contextUsage(): RunContext {
    const window_tokens = this.plan.resolved.contextWindow
    const sum = (messages: readonly StoredMessage[]) =>
      messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
    const base = this.contextBase
    if (!base) {
      const history = [...this.plan.request.messages, ...this.newMessages]
      return { used_tokens: this.systemTokens + this.toolTokens + sum(history), window_tokens, estimated: true }
    }
    const { call } = base
    // after the call, its answer (already in output_tokens) and tool messages are appended
    const tail = this.newMessages.slice(base.messagesBefore).filter((m) => m.role === 'tool')
    return {
      used_tokens:
        call.input_tokens + call.cache_read_tokens + call.cache_write_tokens + call.output_tokens + sum(tail),
      window_tokens,
      estimated: call.estimated || tail.length > 0,
    }
  }

  private emitStepEvent(step: number, outcome: StepOutcome): void {
    const last = this.usage.calls[this.usage.calls.length - 1]
    this.record.sse.emit('step', {
      index: step,
      finish_reason: outcome.finishReason,
      usage: last
        ? {
            input_tokens: last.input_tokens,
            output_tokens: last.output_tokens,
            cache_read_tokens: last.cache_read_tokens,
            cache_write_tokens: last.cache_write_tokens,
          }
        : null,
    })
    log.info(
      'step_done',
      {
        run_id: this.record.runId,
        step,
        finish_reason: outcome.finishReason,
        duration_ms: outcome.durationMs,
        input_tokens: last?.input_tokens,
        output_tokens: last?.output_tokens,
        tool_calls: outcome.toolCalls.length > 0 ? outcome.toolCalls.map((c) => c.tool) : undefined,
        tools_disabled: this.toolsDisabled || undefined,
      },
      {
        text: outcome.text || undefined,
        reasoning: outcome.reasoningText || undefined,
        tool_calls:
          outcome.toolCalls.length > 0
            ? outcome.toolCalls.map((c) => ({
                call_id: c.callId,
                tool: c.tool,
                args: c.args,
                ...(c.invalid ? { invalid: c.invalidReason ?? true } : {}),
              }))
            : undefined,
      },
    )
  }

  /* -------------------------------------------------------- tool execution */

  /** @returns true if at least one tool answered deferred (SPEC §6.3). */
  private async executeToolBatch(calls: StepToolCall[]): Promise<boolean> {
    const { plan } = this

    // A repeat of a previous step's call with the same tool + args is not executed: the answer
    // would be the same, and the model would keep calling the tool until max_steps (SPEC §6.7)
    const repeated = new Set<string>()
    for (const call of calls) {
      if (this.seenCalls.has(callKey(call))) repeated.add(call.callId)
    }

    // Rejection before execution: unparsed arguments, an unknown tool, and
    // args that fail input_schema. Such a call must not reach a write endpoint —
    // it would create an operation with missing fields (SPEC §6.1, §6.4).
    const rejected = new Map<string, string>()
    // a deferred tool the model has never seen the schema of (§6.8); not a repeat candidate
    const notLoaded = new Set<string>()
    for (const call of calls) {
      if (repeated.has(call.callId)) continue
      if (this.skills.isHidden(call.tool)) {
        notLoaded.add(call.callId)
        rejected.set(call.callId, this.skills.notLoadedError(call.tool))
        continue
      }
      if (call.invalid) {
        rejected.set(call.callId, `invalid_tool_input: ${call.invalidReason ?? this.texts.invalidCall}`)
        continue
      }
      const def = this.skills.builtin(call.tool) ?? this.toolsByName.get(call.tool)
      if (!def) {
        rejected.set(call.callId, `unknown_tool: ${call.tool}`)
        continue
      }
      const verdict = validateToolArgs(def.input_schema, call.args, this.texts)
      if (!verdict.ok) rejected.set(call.callId, `invalid_tool_input: ${verdict.reason}`)
    }

    // two or more calls of the same write tool in one step are not executed (SPEC §6.3);
    // rejected calls do not count — they never reach the endpoint
    const writeCounts = new Map<string, number>()
    for (const call of calls) {
      if (repeated.has(call.callId) || rejected.has(call.callId)) continue
      if (this.toolsByName.get(call.tool)?.effect !== 'write') continue
      writeCounts.set(call.tool, (writeCounts.get(call.tool) ?? 0) + 1)
    }
    const duplicated = new Set([...writeCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name))

    const tasks = calls.map((call) => async (): Promise<CallResult> => {
      if (repeated.has(call.callId)) {
        log.warn(
          'tool_call_repeated',
          { run_id: this.record.runId, call_id: call.callId, tool: call.tool },
          { args: call.args },
        )
        return {
          call,
          outcome: { kind: 'error', error: this.texts.repeatedCall, status: 'error' },
          durationMs: 0,
          ...(this.skills.builtin(call.tool) ? { builtin: true as const } : {}),
        }
      }
      const rejection = rejected.get(call.callId)
      if (rejection) {
        const reason = notLoaded.has(call.callId) ? 'tool_not_loaded' : rejection
        log.warn(
          'tool_call_rejected',
          { run_id: this.record.runId, call_id: call.callId, tool: call.tool, reason },
          { args: call.args },
        )
        return {
          call,
          outcome: { kind: 'error', error: rejection, status: 'error' },
          status: 'error',
          durationMs: 0,
          ...(this.skills.builtin(call.tool) ? { builtin: true as const } : {}),
        }
      }
      if (this.skills.builtin(call.tool)) return this.runBuiltin(call)
      if (duplicated.has(call.tool)) {
        log.warn(
          'duplicate_write_intent',
          {
            run_id: this.record.runId,
            call_id: call.callId,
            tool: call.tool,
            calls_in_step: writeCounts.get(call.tool),
          },
          { args: call.args },
        )
        return {
          call,
          outcome: { kind: 'error', error: 'duplicate_write_intent', status: 'error' },
          status: 'duplicate_write_intent',
          durationMs: 0,
        }
      }
      return this.runSingleTool(call)
    })

    let results: CallResult[]
    if (plan.resolved.capabilities.parallel_tools) {
      results = await Promise.all(tasks.map((t) => t()))
    } else {
      results = []
      for (const task of tasks) results.push(await task())
    }

    // duplicate_write_intent asks for one combined call — it may legitimately match a refused one
    for (const result of results) {
      if (result.status === 'duplicate_write_intent' || notLoaded.has(result.call.callId)) continue
      this.seenCalls.add(callKey(result.call))
    }
    // activations take effect from the next step (§6.8)
    for (const result of results) if (result.activate) this.skills.activate(result.activate)
    this.repeatedCalls += repeated.size
    for (const result of results) {
      if (result.builtin || result.outcome.kind !== 'ok' || !isEmptyToolResult(result.outcome.result)) continue
      this.emptyResults.set(result.call.tool, (this.emptyResults.get(result.call.tool) ?? 0) + 1)
    }

    // the model ignored repeated_call or a tool keeps returning nothing —
    // from here on, only a text answer based on what is already there
    if (!this.toolsDisabled) {
      const emptyTool = [...this.emptyResults].find(([, n]) => n >= MAX_EMPTY_RESULTS)?.[0]
      if (this.repeatedCalls > MAX_REPEATED_CALLS || emptyTool) {
        this.toolsDisabled = true
        log.warn('tools_disabled', {
          run_id: this.record.runId,
          step: this.steps,
          reason: emptyTool ? 'empty_results' : 'repeated_calls',
          repeated_calls: this.repeatedCalls,
          empty_results: Object.fromEntries(this.emptyResults),
          ...(emptyTool ? { tool: emptyTool } : {}),
        })
      }
    }

    let deferred = false
    // results go into the history in the model's tool-call order (SPEC §6.3)
    for (const result of results) {
      const def = this.toolsByName.get(result.call.tool)
      const effect = result.builtin ? 'read' : (def?.effect ?? 'read')
      const builtin = result.builtin ? { builtin: true as const } : {}

      if (result.outcome.kind === 'deferred') {
        deferred = true
        this.attachOperationId(result.call.callId, result.outcome.operationId)
        this.toolSummaries.push({
          call_id: result.call.callId,
          tool: result.call.tool,
          effect,
          status: 'deferred',
          duration_ms: result.durationMs,
          truncated: false,
          operation_id: result.outcome.operationId,
        })
        this.record.sse.emit('tool_result', {
          call_id: result.call.callId,
          ok: true,
          truncated: false,
          status: 'deferred',
        })
        continue
      }

      if (result.outcome.kind === 'ok') {
        this.pushToolMessage({
          call_id: result.call.callId,
          tool: result.call.tool,
          result: result.outcome.result,
          is_error: false,
          truncated: result.outcome.truncated,
          ...builtin,
        })
        this.toolSummaries.push({
          call_id: result.call.callId,
          tool: result.call.tool,
          effect,
          status: 'ok',
          duration_ms: result.durationMs,
          truncated: result.outcome.truncated,
          operation_id: null,
          ...builtin,
        })
        this.record.sse.emit('tool_result', {
          call_id: result.call.callId,
          ok: true,
          truncated: result.outcome.truncated,
          status: 'ok',
          ...(this.plan.request.stream.expose_result ? { result: result.outcome.result } : {}),
        })
        continue
      }

      const status: ToolCallStatus = result.status ?? result.outcome.status
      this.pushToolMessage({
        call_id: result.call.callId,
        tool: result.call.tool,
        error: result.outcome.error,
        is_error: true,
        ...builtin,
      })
      this.toolSummaries.push({
        call_id: result.call.callId,
        tool: result.call.tool,
        effect,
        status,
        duration_ms: result.durationMs,
        truncated: false,
        operation_id: null,
        ...builtin,
      })
      this.record.sse.emit('tool_result', {
        call_id: result.call.callId,
        ok: false,
        truncated: false,
        status,
        ...(this.plan.request.stream.expose_result ? { error: result.outcome.error } : {}),
      })
    }

    return deferred
  }

  /**
   * An engine tool (§6.8): no endpoint, no retry, no truncation, not counted toward
   * max_tool_calls. The journal gets its own events, not tool_call / tool_result, which
   * describe HTTP endpoints.
   */
  private runBuiltin(call: StepToolCall): CallResult {
    const started = Date.now()
    if (call.tool === BUILTIN_TOOLS.searchTools) {
      const found = this.skills.search(call.args)
      // the query is model text: content only (§12.2); names from the request are metadata
      log.info(
        'tool_search',
        {
          run_id: this.record.runId,
          step: this.steps,
          limit: found.limit,
          tools: found.result.tools,
          in_skills: found.result.in_skills,
        },
        { query: found.query },
      )
      return {
        call,
        outcome: { kind: 'ok', result: found.result, truncated: false },
        durationMs: Date.now() - started,
        builtin: true,
        activate: found.result.tools,
      }
    }
    const loaded = this.skills.loadSkill(call.args)
    const durationMs = Date.now() - started
    if (!loaded.ok) {
      // the name is model text and may carry user data: content only (§12.2)
      log.warn('skill_unknown', { run_id: this.record.runId, step: this.steps, call_id: call.callId }, { name: loaded.name })
      return { call, outcome: { kind: 'error', error: loaded.text, status: 'error' }, durationMs, builtin: true }
    }
    log.info('skill_loaded', {
      run_id: this.record.runId,
      step: this.steps,
      name: loaded.name,
      tools: loaded.tools,
      reloaded: loaded.reloaded,
    })
    return {
      call,
      outcome: { kind: 'ok', result: loaded.text, truncated: false },
      durationMs,
      builtin: true,
      activate: loaded.tools,
    }
  }

  private async runSingleTool(call: StepToolCall): Promise<CallResult> {
    const { plan, deps, record } = this
    const def = this.toolsByName.get(call.tool)
    const started = Date.now()

    if (!def) {
      return {
        call,
        outcome: { kind: 'error', error: `unknown_tool: ${call.tool}`, status: 'error' },
        durationMs: 0,
      }
    }

    this.toolCallsUsed++
    const callRecord = deps.registry.registerCall(record, call.callId, call.tool)
    const timeoutMs = Math.min(def.timeout_ms ?? 30_000, 300_000)

    log.info(
      'tool_call',
      {
        run_id: record.runId,
        step: this.steps,
        call_id: call.callId,
        tool: call.tool,
        effect: def.effect,
        endpoint: safeUrl(def.endpoint),
        timeout_ms: timeoutMs,
      },
      { args: call.args },
    )

    const outcome = await callTool(deps.egress, def, call.args, timeoutMs, {
      runId: record.runId,
      callId: call.callId,
      originRequestId: plan.request.idempotency_key ?? null,
      meta: plan.request.meta,
      resultUrl: `${deps.config.publicUrl}/runs/${record.runId}/tool-result?token=${callRecord.token}`,
      toolResultMaxBytes: plan.limits.tool_result_max_bytes,
      toolResponseMaxBytes: deps.config.toolResponseMaxBytes,
      signal: record.abort.signal,
      waitForAsyncResult: (callId, ms, signal) =>
        deps.registry.awaitCallResult(record, callId, ms, signal),
    })

    deps.registry.closeCall(callRecord)
    const durationMs = Date.now() - started
    log.info(
      'tool_result',
      {
        run_id: record.runId,
        step: this.steps,
        call_id: call.callId,
        tool: call.tool,
        duration_ms: durationMs,
        outcome: outcome.kind,
        ...(outcome.kind === 'ok'
          ? { truncated: outcome.truncated || undefined, empty: isEmptyToolResult(outcome.result) || undefined }
          : {}),
        ...(outcome.kind === 'error' ? { status: outcome.status, error: outcome.error } : {}),
        ...(outcome.kind === 'deferred' ? { operation_id: outcome.operationId } : {}),
      },
      outcome.kind === 'ok' ? { result: outcome.result } : undefined,
    )

    // abort while a batch is executing: executed calls keep their result, the rest are
    // cancelled (SPEC §6.5, §10.1.5)
    if (outcome.kind === 'error' && record.abort.signal.aborted && outcome.error === 'cancelled') {
      return { call, outcome, status: 'cancelled', durationMs }
    }
    return { call, outcome, durationMs }
  }

  /* -------------------------------------------------- format gate (§5.4) */

  /**
   * Checks blocks in the final answer. A block that fails gets repair steps with
   * tool_choice none: the model receives its answer as is and a synthetic
   * user message with the errors. The result is ONE assistant message: the original text
   * without the fence's blocks plus the block that passed; not repaired — no block.
   * Synthetics and drafts never enter the run's messages — only the journal.
   *
   * @returns cancelled — a cancel / shutdown arrived during repair: the run
   * ends cancelled. A run timeout and budgets here are not a run failure but a
   * repair failure: the model's answer already exists, the run ends completed.
   */
  private async applyOutputChecks(step: number, message: AssistantMessage | null): Promise<'done' | 'cancelled'> {
    const original = message ? textOf(message) : ''
    const repaired = new Map<string, string>()
    const stripped = new Set<string>()

    for (const check of this.plan.outputChecks) {
      const verdict = checkText(original, check, this.texts)

      if (verdict.kind === 'absent') {
        this.outputCheckResults.push({ fence: check.fence, status: 'absent', attempts: 0 })
        this.logOutputCheck('debug', step, check.fence, 0, 'absent')
        continue
      }
      if (verdict.kind === 'valid') {
        this.outputCheckResults.push({ fence: check.fence, status: 'passed', attempts: 0 })
        this.record.sse.emit('output_check', { fence: check.fence, attempt: 0, status: 'passed' })
        this.logOutputCheck('info', step, check.fence, 0, 'passed')
        continue
      }

      this.logOutputCheck('warn', step, check.fence, 0, 'invalid', verdict.issues, { block: verdict.block.raw })
      const outcome = await this.repairBlock(step, check, verdict.issues)
      stripped.add(check.fence)

      if (outcome.ok) {
        repaired.set(check.fence, outcome.raw)
        this.outputCheckResults.push({
          fence: check.fence,
          status: 'repaired',
          attempts: outcome.attempts,
          errors: issueLines(verdict.issues, this.texts),
        })
        this.record.sse.emit('output_check', { fence: check.fence, attempt: outcome.attempts, status: 'repaired' })
        continue
      }

      this.outputCheckResults.push({
        fence: check.fence,
        status: 'failed',
        attempts: outcome.attempts,
        errors: issueLines(verdict.issues, this.texts),
        reason: outcome.reason,
      })
      this.record.sse.emit('output_check', {
        fence: check.fence,
        attempt: outcome.attempts,
        status: 'failed',
        errors: issuePaths(outcome.issues),
      })
      log.warn('output_check', {
        run_id: this.record.runId,
        step,
        fence: check.fence,
        attempt: outcome.attempts,
        outcome: 'failed',
        reason: outcome.reason,
        errors: issuePaths(outcome.issues),
      })
    }

    if (message && stripped.size > 0) {
      let text = original
      for (const fence of stripped) text = stripBlocks(text, fence)
      for (const [fence, raw] of repaired) text = appendBlock(text, fence, raw)
      this.replaceFinalText(message, text)
    }

    const aborted = this.record.abort.signal.aborted && this.record.abortReason !== 'run_timeout'
    return aborted ? 'cancelled' : 'done'
  }

  /** Repair steps for one fence; each is one model call outside max_steps, but within usage and budgets. */
  private async repairBlock(step: number, check: CompiledOutputCheck, issues: Issue[]): Promise<RepairOutcome> {
    const trail: StoredMessage[] = []
    let lastIssues = issues

    for (let attempt = 1; ; attempt++) {
      if (attempt > check.maxRepairs) {
        return { ok: false, attempts: attempt - 1, reason: 'repairs_exhausted', issues: lastIssues }
      }
      if (this.record.abort.signal.aborted) {
        return { ok: false, attempts: attempt - 1, reason: this.abortedRepairReason(), issues: lastIssues }
      }

      this.record.sse.emit('output_check', {
        fence: check.fence,
        attempt,
        status: 'repairing',
        errors: issuePaths(lastIssues),
      })
      // GigaChat allows one system message per request — the feedback comes from user
      trail.push({ role: 'user', content: [{ type: 'text', text: repairPrompt(check.fence, lastIssues, this.texts) }] })

      this.repairing = { fence: check.fence, attempt }
      let outcome: Awaited<ReturnType<RunExecution['callProvider']>>
      try {
        outcome = await this.callProvider(await this.buildPrompt(step, trail), step, true)
      } finally {
        this.repairing = null
      }

      if (typeof outcome === 'string') {
        const reason: OutputCheckFailReason =
          outcome === 'budget_exceeded'
            ? (this.repairBudgetLimit ?? 'max_total_tokens')
            : outcome === 'aborted'
              ? this.abortedRepairReason()
              : 'provider_failure'
        return { ok: false, attempts: attempt, reason, issues: lastIssues }
      }

      const verdict = checkText(outcome.text, check, this.texts)
      if (verdict.kind === 'valid') {
        this.logOutputCheck('info', step, check.fence, attempt, 'repaired', [], { draft: outcome.text })
        return { ok: true, attempts: attempt, raw: verdict.raw }
      }

      lastIssues =
        verdict.kind === 'absent'
          ? [{ path: ISSUE_MISSING, message: this.texts.blockMissing(check.fence) }]
          : verdict.issues
      this.logOutputCheck('warn', step, check.fence, attempt, verdict.kind === 'absent' ? 'missing' : 'invalid', lastIssues, {
        draft: outcome.text,
      })
      // an empty answer does not go into the history: Anthropic rejects an assistant message with no content
      if (outcome.text.trim().length > 0) {
        trail.push({ role: 'assistant', content: [{ type: 'text', text: outcome.text }] })
      }
    }
  }

  private abortedRepairReason(): OutputCheckFailReason {
    return this.record.abortReason === 'run_timeout' ? 'run_timeout' : 'cancelled'
  }

  /**
   * The final message's text — as one text part in place of the first; reasoning
   * stays. An empty message (the answer was only the block, and it was not repaired)
   * is removed: providers reject an assistant message with no content in the next run.
   */
  private replaceFinalText(message: AssistantMessage, text: string): void {
    const content: AssistantPart[] = []
    let placed = false
    for (const part of message.content) {
      if (part.type !== 'text') {
        content.push(part)
        continue
      }
      if (!placed && text.length > 0) content.push({ type: 'text', text })
      placed = true
    }
    message.content = content
    if (content.length > 0) return
    const index = this.newMessages.indexOf(message)
    if (index === this.newMessages.length - 1) {
      this.newMessages.pop()
      this.seq--
    }
  }

  private logOutputCheck(
    level: 'debug' | 'info' | 'warn',
    step: number,
    fence: string,
    attempt: number,
    outcome: 'absent' | 'passed' | 'invalid' | 'missing' | 'repaired',
    issues: readonly Issue[] = [],
    content: Record<string, unknown> = {},
  ): void {
    // paths are metadata; error texts quote the model's answer — journal only (§12.2)
    log[level](
      'output_check',
      {
        run_id: this.record.runId,
        step,
        fence,
        attempt,
        outcome,
        ...(issues.length > 0 ? { errors: issuePaths(issues) } : {}),
      },
      { ...(issues.length > 0 ? { issues: issueLines(issues, this.texts) } : {}), ...content },
    )
  }

  private repairFields(): Record<string, unknown> {
    return this.repairing ? { repair: this.repairing.fence, repair_attempt: this.repairing.attempt } : {}
  }

  /* ------------------------------------------------------------ history */

  private pushAssistant(parts: AssistantPart[], partial: boolean): AssistantMessage | null {
    if (parts.length === 0) return null
    const message: AssistantMessage = {
      role: 'assistant',
      content: parts,
      ...(partial ? { partial: true as const } : {}),
      run_id: this.record.runId,
      seq: this.seq++,
      created_at: new Date().toISOString(),
    }
    this.newMessages.push(message)
    return message
  }

  private pushToolMessage(input: {
    call_id: string
    tool: string
    result?: unknown
    error?: string
    is_error: boolean
    operation_id?: string
    truncated?: boolean
    builtin?: true
  }): void {
    this.newMessages.push({
      role: 'tool',
      call_id: input.call_id,
      tool: input.tool,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      is_error: input.is_error,
      ...(input.operation_id ? { operation_id: input.operation_id } : {}),
      ...(input.truncated ? { truncated: true } : {}),
      ...(input.builtin ? { builtin: true as const } : {}),
      run_id: this.record.runId,
      seq: this.seq++,
      created_at: new Date().toISOString(),
    })
  }

  private attachOperationId(callId: string, operationId: string): void {
    for (const message of this.newMessages) {
      if (message.role !== 'assistant') continue
      for (const part of message.content) {
        if (part.type === 'tool_call' && part.call_id === callId) part.operation_id = operationId
      }
    }
  }

  /**
   * The §5 invariant: every tool_call has a paired tool message. Unclosed ones
   * get a synthetic error; deferred ones (with operation_id) are skipped — their
   * result arrives in the next run.
   */
  private sealUnresolvedToolCalls(errorText: string, status: ToolCallStatus): void {
    const answered = new Set<string>()
    for (const m of this.newMessages) if (m.role === 'tool') answered.add(m.call_id)

    const pending: Array<{ callId: string; tool: string }> = []
    for (const message of this.newMessages) {
      if (message.role !== 'assistant') continue
      for (const part of message.content) {
        if (part.type !== 'tool_call') continue
        if (part.operation_id) continue
        if (answered.has(part.call_id)) continue
        pending.push({ callId: part.call_id, tool: part.tool })
      }
    }

    if (pending.length > 0) {
      log.info('tool_calls_sealed', {
        run_id: this.record.runId,
        step: this.steps,
        reason: errorText,
        calls: pending.map((p) => `${p.tool}#${p.callId}`),
      })
    }
    for (const item of pending) {
      this.pushToolMessage({
        call_id: item.callId,
        tool: item.tool,
        error: errorText,
        is_error: true,
      })
      const existing = this.toolSummaries.find((s) => s.call_id === item.callId)
      if (existing) {
        existing.status = status
      } else {
        this.toolSummaries.push({
          call_id: item.callId,
          tool: item.tool,
          effect: this.toolsByName.get(item.tool)?.effect ?? 'read',
          status,
          duration_ms: 0,
          truncated: false,
          operation_id: null,
          ...(this.skills.builtin(item.tool) ? { builtin: true as const } : {}),
        })
      }
    }
  }

  /* ----------------------------------------------------------- terminal */

  /** A §10 limit / §10.2 budget was hit: which one and at what numbers. */
  private logLimit(limit: string, fields: Record<string, unknown>): void {
    log.warn('limit_hit', { run_id: this.record.runId, limit, ...fields })
  }

  private finishAborted(): void {
    if (this.finished) return
    const reason = this.record.abortReason
    if (reason === 'run_timeout') {
      this.sealUnresolvedToolCalls('not_executed: run_timeout', 'not_executed')
      this.finish('failed', 'run_timeout', {
        code: 'run_timeout',
        message: this.texts.runTimeout(this.plan.limits.timeout_ms),
        retriable: true,
      })
      return
    }
    this.sealUnresolvedToolCalls('cancelled', 'cancelled')
    this.finish('cancelled', reason === 'shutdown' ? 'shutdown' : 'user')
  }

  private finish(
    status: Exclude<RunStatus, 'running' | 'cancelling'>,
    finishReason: string,
    error?: RunResult['error'],
  ): void {
    if (this.finished) return
    this.finished = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)

    const { record, plan, deps } = this
    const finishedAt = Date.now()
    const usage = this.usage.snapshot()
    const context = this.contextUsage()
    const retention = record.acked ? deps.config.runRetentionMs : deps.config.runRetentionUnackedMs

    const result: RunResult = {
      contract_version: CONTRACT_VERSION,
      run_id: record.runId,
      status,
      finish_reason: finishReason,
      history_revision: record.historyRevision,
      meta: record.meta,
      messages: this.newMessages,
      usage,
      tool_calls: this.toolSummaries,
      timing: {
        started_at: record.startedAtIso,
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - record.startedAt,
        steps: this.steps,
        queue_wait_ms: this.queueWaitMs,
      },
      expires_at: new Date(finishedAt + retention).toISOString(),
      context_trimmed: this.contextTrimmed,
      context,
      // the field is present only if the gate was requested; [] — the run never reached the final text
      ...(plan.outputChecks.length > 0 ? { output_checks: this.outputCheckResults } : {}),
      error: error ?? null,
    }

    deps.registry.markTerminal(record, result)
    record.liveUsage = () => usage

    record.sse.emit('done', {
      status,
      finish_reason: finishReason,
      usage,
      ...(error ? { error: publicError(error) } : {}),
    })

    log[status === 'failed' ? 'error' : 'info'](
      'run_done',
      {
        run_id: record.runId,
        session_id: record.sessionId,
        status,
        finish_reason: finishReason,
        steps: this.steps,
        tool_calls: this.toolSummaries.length,
        duration_ms: result.timing.duration_ms,
        queue_wait_ms: this.queueWaitMs || undefined,
        input_tokens: usage.total.input_tokens,
        output_tokens: usage.total.output_tokens,
        cache_read_tokens: usage.total.cache_read_tokens || undefined,
        unknown_calls: usage.total.unknown_calls,
        cost: usage.cost ? `${usage.cost.amount} ${usage.cost.currency}` : undefined,
        context_trimmed: this.contextTrimmed || undefined,
        context_tokens: context.used_tokens,
        context_window: context.window_tokens,
        ...(error ? { error_code: error.code, error_message: error.message } : {}),
      },
      { answer: finalText(this.newMessages) || undefined, provider_body: error?.provider_body },
    )
    if (status === 'failed') {
      sendAlert('run_failed', {
        run_id: record.runId,
        session_id: record.sessionId,
        meta: record.meta,
        status,
        finish_reason: finishReason,
        // no provider_body: the provider's body may quote the prompt
        error: result.error
          ? {
              code: result.error.code,
              message: result.error.message,
              retriable: result.error.retriable,
              provider_status: result.error.provider_status ?? null,
            }
          : null,
        provider: result.usage.calls.at(-1)?.provider ?? null,
        model: result.usage.calls.at(-1)?.model ?? null,
      })
    }

    record.deliveryPromise = deliverCallback(record, result, deps).catch((err) => {
      log.error('callback_failed', { run_id: record.runId, err: String(err) })
    })
    this.releaseProvider()
  }

  /**
   * Provider cleanup — GigaChat files (SPEC §5.3). Right at the terminal state, so that
   * shutdown, having waited for the terminal state, already sees the promise; the result and the callback do not wait for it.
   */
  private releaseProvider(): void {
    if (this.released) return
    this.released = true
    this.record.releasePromise = this.plan.resolved.release?.(this.record.runId) ?? null
  }
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

/** The assistant's last text in the run — what the user saw. */
function finalText(messages: readonly StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('')
    if (text) return text
  }
  return ''
}

interface CallResult {
  call: StepToolCall
  outcome: ToolOutcome
  status?: ToolCallStatus
  durationMs: number
  /** An engine tool (§6.8): marked in the history and in tool_calls[]. */
  builtin?: true
  /** Deferred tools to make visible from the next step. */
  activate?: string[]
}

/** tool + args with sorted keys: {a, b} and {b, a} are the same call. */
function callKey(call: StepToolCall): string {
  return `${call.tool}\u0000${stableJson(call.args)}`
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * Tools in the order given. cache_control goes on the last non-deferred tool: the tail of
 * the schemas that are stable between turns (SPEC §9.3); a deferred tool with cache_control
 * is a 400 (§6.8).
 */
function buildToolSet(tools: readonly ModelTool[], cacheLast: boolean): ToolSet {
  const set: ToolSet = {}
  const lastEager = tools.findLastIndex((t) => !t.deferred)
  tools.forEach((def, index) => {
    const anthropic = {
      ...(cacheLast && index === lastEager ? { cacheControl: { type: 'ephemeral' } } : {}),
      ...(def.deferred ? { deferLoading: true } : {}),
    }
    set[def.name] = tool({
      ...(def.description ? { description: def.description } : {}),
      inputSchema: jsonSchema(def.input_schema as never),
      ...(Object.keys(anthropic).length > 0 ? { providerOptions: { anthropic } } : {}),
    })
  })
  return set
}

/**
 * Did not get a slot: the queue timeout, or the run's timeout_ms firing while waiting
 * (SPEC §11.6). An abort before queueing (queueDepth 0) is a plain run_timeout.
 */
function isQueueTimeout(ticket: AcquireResult, abortReason: RunRecord['abortReason']): boolean {
  if (ticket.kind === 'timeout') return true
  return ticket.kind === 'aborted' && ticket.queueDepth > 0 && abortReason === 'run_timeout'
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
