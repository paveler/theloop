# theloop — Roadmap

> Status: **proposal**, not a commitment. Nothing here is part of the contract until it
> lands in [SPEC.md](SPEC.md). Each kernel item becomes a short RFC (a PR against SPEC.md)
> before code.

## Where theloop sits

Personal agents (Hermes Agent, OpenClaw and the like) are one long-running process per
person: local state in SQLite and Markdown, many chat channels, skills, cron, tools that run
on the host. They are excellent at being *your* assistant. By their own documentation
they are one trust domain per instance — not multi-tenant, not billing-grade, not built to
sit inside someone else's product.

theloop is the other half of that space: **the loop inside assistants you ship to many
users.**

| | Personal agents | theloop |
|---|---|---|
| Unit of deployment | one instance per person / trust domain | one engine for many tenants |
| State | inside the agent (SQLite, Markdown) | in the harness; the engine is stateless |
| Configuration | files on the host | every request carries model, key, prompt, tools, limits |
| Provider keys | per instance | per request |
| Usage | estimates per model | one record per provider attempt, `estimated` flags, optional cost |
| Side effects | tools act directly, guarded by approval heuristics | writes are intents (`deferred`); mutation happens after approval in the harness |
| Failure model | restart → runs `unknown` | at-least-once result, deadline recovery, late results placed by revision |

The strategy follows from this table: **keep the kernel stateless and boring, and grow
personal-agent capabilities in layers around it** — never inside it.

## Layers

```
L4  SDKs, conformance kit, eval / replay CLI, deploy templates
L3  tool servers: exec sandboxes, browser, files, web, MCP bridge      (HTTP tools, §6)
L2  theloop-harness: storage, tenants, approvals, memory, skills,      (a client of L0)
    scheduler, channels
L1  kernel protocol extensions (stateless)                             (this repo)
L0  kernel: the loop, SPEC v1                                          (this repo)
```

L2 and L3 are ordinary clients and tool endpoints of the L0 contract. Any harness — a
backend, a low-code platform, a workflow tool — can replace them.

Effort: **S** — days, **M** — 1–2 weeks, **L** — a month or more.

## Phase 0 — public release of v1

| Item | Effort |
|---|---|
| Extract the reference implementation; English code comments; locale layer (`en` / `ru`, Appendix B); `DEFAULT_TIMEZONE` | M |
| CI (typecheck + tests), Docker image on GHCR, versioned releases — **done in v1.0.1** | S |
| README quickstart: `docker run` + one `curl` with `wait: true` | S |
| `SECURITY.md`: threat model, supported versions, disclosure process with a response SLA | S |
| `examples/sqlite-harness`: a complete harness on SQLite — history, a read tool, a write tool with approval, continuation, recovery — with an end-to-end test — **done** | M |
| A thin harness SDK (TypeScript): apply results idempotently, ack, deadline recovery, the write-endpoint lookup order — with storage as callbacks, so a harness is mostly glue | M |
| A first external integration: someone outside the project embeds theloop from the docs alone; every place they get confused becomes a docs or SPEC fix | — |

## Phase 1 — reach (v1.1)

Goal: works with whatever models and tools a team already has.

**1.1 Providers.** OpenRouter as a named provider (one key, hundreds of models, provider-side
cost in usage). Google Gemini native (thought signatures fit the existing `reasoning` part).
Mistral, Qwen, Kimi, YandexGPT. **Local models** (Ollama, vLLM, llama.cpp, LM Studio) through
`openai-compatible` with an explicit `EGRESS_PRIVATE_ALLOWLIST` — today private addresses are
refused unconditionally. — **M**

**1.2 Model fallbacks.** `llm.fallbacks[]`: on `provider_unavailable`, `provider_rate_limited`
or `provider_auth` **before the first content event**, the step moves to the next model.
Every attempt stays in `usage.calls[]` with its provider; `reasoning` parts stay tagged by
provider, so a mixed history replays correctly. — **S**

**1.3 Stream-delivered tools.** `tools[].transport: "stream"`: the engine does not call an
endpoint; it emits the call with args to Bearer-authenticated SSE subscribers and waits for
`POST /runs/{id}/tool-result` — the existing `accepted` path without the HTTP hop. This lets a
harness behind NAT (a laptop, a desktop app, a browser tab) execute tools locally while the
engine runs anywhere. Write tools over this transport still answer `deferred`. — **S**

**1.4 MCP tools.** `tools[]` entry `{ type: "mcp", server_url, headers, allow? }`. The engine
connects over streamable HTTP per run (egress rules apply), lists tools, maps them to model
tools and calls them. **The write-intent invariant holds:** only tools that are read-only
(`readOnlyHint` or an explicit `allow` list) are executed by the engine; any other MCP tool
is exposed to the model with `transport: "stream"` semantics, so the harness approves and
executes it. MCP OAuth is the harness's job; the engine receives headers. — **M**

**1.5 Provider-native server tools.** `tools[]` entry `{ type: "provider", name, config }` for
web search, web fetch and code execution where the provider runs them (Anthropic, OpenAI,
Gemini). Server-tool usage (searches, container time) is added to `usage.calls[]`. — **S**

**1.6 OpenTelemetry.** Traces per run → step → attempt → tool with GenAI semantic conventions;
content only with an explicit flag, same rules as the journal. Works with Langfuse, Phoenix,
Datadog. — **S**

## Phase 2 — long-running assistants (v1.2)

Goal: everything a weeks-long assistant needs from the kernel, without kernel state.

**2.1 `effect: "state"`.** A third effect for writes to the agent's own state — memory, notes,
todo lists. Synchronous answers allowed; the endpoint MUST be idempotent by `call_id`; no
approval; no effects outside the agent. Today such tools must either pretend to be `read` or
pay the full `deferred` round trip. — **S**

**2.2 Skills on demand.** `skills[]` in the request: `{ name, description, body }`, compatible
with the `SKILL.md` format. The engine puts an index (name + description) into the static part
of the prompt and exposes a built-in `load_skill` tool that returns the body — no network, no
code execution. All tools are still declared up front: adding tools mid-run would reset the
prompt cache. Skills come from the harness, which is trusted, so the kernel has no
supply-chain surface. — **M**

**2.3 Compaction as a call.** `POST /compact`: the engine summarizes a history prefix by a
prompt from the request and returns `{ summary_message, replaces_through_seq }`. The harness
stores it and sends the compacted history next time. The trigger is the harness's call —
`result.context.used_tokens / window_tokens` already tells it when. Provider-native context
editing is passed through where available. — **M**

**2.4 Sub-runs.** A tool entry `{ type: "agent", name, description, llm, system, tools,
limits }`: the parent model hands a task to a child loop inside the same run; the child's
final text is the tool result. Child attempts appear in `usage.calls[]` with a parent
reference, child limits are capped by the parent's remaining budget, and children are
read-only in v1 (a child `deferred` has no good place to surface). — **M**

**2.5 Structured final output.** `response_format: { schema }`: native structured output where
the provider supports it, otherwise the §5.4 gate applied to the whole answer. — **S**

## Phase 3 — the assistant around the loop (theloop-harness)

Goal: parity with personal agents on what users actually touch, built as a separate package
on top of the contract. Multi-tenant from day one; single-user is just one tenant.

| Component | What | Effort |
|---|---|---|
| Storage | SQLite (single node) / Postgres; sessions, messages, runs, operations, `opref`; Appendix A obligations implemented and tested | M |
| Tenancy | tenants → users → assistants; encrypted key vault; quotas and spend caps from usage; cost from price lists | M |
| Approvals | inbox UI, webhook, chat-native buttons (approve / reject with `operation_version`) | M |
| Channels | Telegram first, then web widget, WhatsApp Cloud API, Slack, email. Inbound → `user` message with `created_at`; outbound streaming → message edits | M per channel |
| Memory | memory tools on `effect: "state"`; a memory snapshot frozen at session start so it never breaks the prompt cache | M |
| Scheduler | cron and heartbeats as runs with `event` parts; **every scheduled run has a hard `max_cost`**, plus a daily cap per assistant — unbounded heartbeats are the most common cost failure of personal agents | S |
| Skills registry | import `SKILL.md` from public hubs only after review, pinned by content hash, never auto-updated; instructions only, scripts run in L3 sandboxes | M |
| Admin UI | sessions, run timeline (from `/logs`), usage and cost dashboards | M |

## Phase 4 — scale and operate

**4.1 Several instances.** A Redis adapter for the session lock, the idempotency index, the
SSE buffer and terminal results. This is **not** durable execution: an in-flight run still
dies with its process; Redis only makes locks and results visible across instances.
Alternatively, sticky routing by `run_id` with a reference config. — **L**

**4.2 Scoped server tokens.** Several harnesses with separate tokens, each with its own egress
allowlist and limits, for a hosted engine serving several customers. — **M**

**4.3 Replay and evals.** A run is fully described by its request, so it can be replayed:
`theloop replay` reruns a captured request against another model or prompt, with tool answers
mocked from the journal; `theloop eval` runs a suite of conversations with assertions (tools
called, blocks valid, LLM-judge checks). Stateless means reproducible — few agent runtimes can
offer this cheaply. — **M**

**4.4 Deploy templates.** Helm chart; Fly, Railway, Render templates; a hardened default
`EGRESS_ALLOWLIST` example. — **S**

## Deliberately not planned

- **State in the kernel** — memory, skills storage, sessions, a database. That road leads to a
  worse personal agent.
- **Step-level durable execution** (Restate / DBOS style). Recovery is a new run with a longer
  history; this is a design decision, not a gap.
- **Approval logic in the kernel.** Approvals stay in the harness through `deferred`.
- **Native desktop and mobile nodes, voice, canvas.** Personal-agent territory with strong
  incumbents.
- **A plugin marketplace before there are users.** Registries are the main supply-chain attack
  surface in this space.
- **Dozens of channels.** A few, done well.

## Open questions

1. `transport: "stream"` and MCP non-read tools: is "harness executes after approval" enough,
   or do some deployments need an explicit opt-out for trusted MCP servers?
2. `effect: "state"`: should the engine enforce anything beyond the `call_id` idempotency
   requirement (for example, exclude `state` tools from `duplicate_write_intent`)?
3. Compaction: does the summary belong in a `user` message with an `event` part, or in a new
   `StoredMessage` role? The first keeps v1 clients working.
4. Harness storage: start with SQLite only, or ship Postgres from the start because the target
   is multi-tenant?
