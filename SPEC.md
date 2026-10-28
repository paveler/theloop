# theloop — Specification

> **Status:** v1.0 · `contract_version: "1"` · the contract is frozen and implemented.
> Reference implementation (this repository): Node 22 + TypeScript, Hono, Vercel AI SDK 6.
> License: Apache 2.0.
>
> This document is normative for the HTTP contract, the message format and the loop
> semantics. Whatever it does not describe is an implementation detail. Plans and
> proposals live in [ROADMAP.md](ROADMAP.md) and are **not** part of the contract.

## Contents

0. [Conventions](#0-conventions)
1. [What theloop is](#1-what-theloop-is)
2. [Division of responsibilities](#2-division-of-responsibilities)
3. [Execution model: the run](#3-execution-model-the-run)
4. [HTTP API](#4-http-api)
5. [Message format — `StoredMessage`](#5-message-format--storedmessage)
6. [Tools](#6-tools)
7. [Result and callback](#7-result-and-callback)
8. [Usage and billing](#8-usage-and-billing)
9. [Providers](#9-providers)
10. [Limits and timeouts](#10-limits-and-timeouts)
11. [Reliability](#11-reliability)
12. [Errors and observability](#12-errors-and-observability)
13. [Conformance tests](#13-conformance-tests)
14. [Deployment and configuration](#14-deployment-and-configuration)
15. [Out of scope for v1](#15-out-of-scope-for-v1)
- [Appendix A. Harness obligations](#appendix-a-harness-obligations)
- [Appendix B. Engine-injected text and locale](#appendix-b-engine-injected-text-and-locale)

## 0. Conventions

**MUST**, **MUST NOT**, **SHOULD**, **MAY** are used as in RFC 2119.

| Term | Meaning |
|---|---|
| **engine** | a theloop process. |
| **harness** | the trusted server-side client of the engine. It owns everything durable: conversation history, assistant / tool configuration, business operations, approvals, billing. It authenticates with `ENGINE_TOKEN`. A backend service, a low-code platform or a workflow tool can be a harness. |
| **end-user client** | a browser or app that watches a run. It never sees `ENGINE_TOKEN`; it gets run-scoped URLs from the harness. |
| **run** | one execution of the loop: from `POST /runs` to a terminal status. |
| **step** | one logical model call plus execution of the tool calls it produced. |
| **attempt** | one real HTTP call to a model provider. A step has one or more attempts (retries); every attempt is accounted for in usage. |
| **session** | a conversation, identified by `meta.session_id`. The engine only uses it for locking and hashing; the session itself lives in the harness. |
| **tool endpoint** | an HTTPS URL that executes a tool. The engine POSTs tool calls to it. |

## 1. What theloop is

**An agent loop as a stateless HTTP service.** One HTTP call = one run. The request
body carries the model, the key, the prompt, the full history, the tools and the
limits. The engine runs "model → tools → model" until a final answer, streams text
over SSE, delivers the result and usage by callback, and **forgets the run**. There
is no state between calls.

Think of it as a model router with an agent loop inside: the harness decides *what*
the assistant is (prompt, tools, model, budget) on every request; the engine decides
*how* the loop runs (steps, retries, limits, streaming, cancellation, accounting).

Design principles:

1. **Everything in the request, nothing in the engine.** No configs, no database, no
   tenant registry. Any harness can drive any assistant.
2. **State lives in the harness.** Conversation memory is a list of `StoredMessage`
   (§5) that the harness stores and sends in full with every run. "Resume" means a
   new run with a longer history.
3. **One logical result, at-least-once delivery.** The callback retries; duplicates
   are possible and are deduplicated by `run_id`. The result stays readable via
   `GET /runs/{id}` for the whole retention period.
4. **Tools are HTTP endpoints; writes are intents.** A tool that changes the world
   (`effect: "write"`) only registers an intent and answers `deferred`. The mutation
   happens in the harness, after durable recording and approval — never inside a
   tool call (§6.4).
5. **Billing-grade usage.** One usage record per provider attempt, including failed
   and interrupted ones, with explicit `estimated` flags (§8).
6. **Controlled egress.** One HTTP client for everything outbound: HTTPS only, host
   allowlist, no private IPs, no redirects, header filtering (§11.4).
7. **Nothing is lost silently.** Graceful shutdown, deadline recovery, late results
   (§3, §11.1).

theloop is **not** a framework or SDK you import, not a personal assistant, not a
database, not an approval UI and not a durable-execution engine. Those are harness
concerns; [ROADMAP.md](ROADMAP.md) describes optional components that may cover them.

## 2. Division of responsibilities

| | Harness | Engine |
|---|---|---|
| Conversation history | **stores** it, sends it in full with every run | receives it, appends new messages, returns them |
| Assistants, skills, tools, models | **stores** them, builds the `POST /runs` body from them | has no notion of "assistant" or "skill" |
| Provider keys | stores them, passes them in the request | takes them from the request; env fallback for named providers |
| Read tools | **executes** them synchronously (an endpoint per tool) | calls them by URL from the request |
| Write tools (mutations) | **owns the operation**: durable `operation_id`, approval, execution | calls the endpoint, receives `deferred`, ends the run |
| Agent loop, streaming, cancellation, limits | — | **all here** |
| Usage and billing | stores usage, computes money from its price list | counts tokens per attempt, returns them in the result |
| Durable idempotency (user message → run) | **here** | only within retention |
| Run start, deadline, result recovery | starts runs, watches deadlines, calls `GET /runs/{id}` on expiry | — |
| Order of history between runs (session automaton, §3.1) | **here** | session lock only until `ack` |

Rule of thumb: **whatever can be solved by storing data or calling an endpoint belongs
to the harness. Whatever needs the loop, the stream or a timer belongs to the
engine.**

## 3. Execution model: the run

```
POST /runs ──► running ──► completed        final answer (end_turn)
                       ├─► stopped_limit    step / token / tool / cost limit
                       ├─► awaiting_tool    a tool answered deferred — continue with a new run
                       ├─► cancelled        stopped by the user / shutdown without grace time
                       └─► failed           provider error, interrupted stream, run timeout, context

running ──cancel──► cancelling ──► cancelled   transient: abort sent, waiting for a tool / provider
                               └─► completed   the abort lost the race to a normal finish
```

- A run lives **in process memory** from `POST /runs` to a terminal status plus
  retention: after `ack` — `RUN_RETENTION_MS` (default 10 min); without `ack` —
  `RUN_RETENTION_UNACKED_MS` (60 min). Then it is deleted without a trace.
- **One logical result** per run. Delivery by callback is at-least-once with retries;
  **duplicates are possible**, the harness deduplicates by `run_id`. Between the
  terminal status and the first delivery there is no guarantee (a crash can happen),
  so the result is available via `GET /runs/{id}` for the whole retention period, and
  the harness **MUST** call `GET` at its deadline before declaring the run lost. The
  recommended deadline is `limits.timeout_ms + 120 s` without a callback (the callback
  retry schedule of §7 fits in about 80 s). Only `404` means `lost`.
- **Process crash** (OOM, `kill -9`): in-memory runs disappear, `GET` returns `404`,
  the harness marks the run `lost` and offers a retry. Tokens of lost runs are not
  reported — see reconciliation, §8.4. A planned shutdown (SIGTERM) delivers
  best-effort, §11.1.
- **`lost` is not final.** A late callback with the same `run_id` (for example from
  an old container after a deploy switched traffic, §14) **MUST** be accepted and
  overwrite `lost` with the real result. Deduplication by `run_id` covers this.
  **Ordering:** if the next run has already started after `lost`, late messages cannot
  simply be appended. The harness compares `history_revision` from the result (an
  echo of the request, §4.2) with the current revision: equal → insert as usual;
  different → keep it as an audit record and surface it in the conversation as an
  `event` part (§5), not as a retroactive assistant turn.
- **Continuation** after `awaiting_tool` / `cancelled` / `stopped_limit` is a new
  `POST /runs` with a longer history.

### 3.1 Sessions between runs: engine lock until `ack` + harness automaton

The race to rule out: run A finishes, the end-user client receives `done`, the
callback is delayed, the user sends the next message, and run B starts with a stale
history. It is solved in two layers.

**Layer 1 — the engine holds the session lock until `ack`.** The lock on
`meta.session_id` is taken at `POST /runs` and is **not released at the terminal
status** — only when the harness confirms the result is recorded in history:

- the callback was delivered (2xx) — implicit ack. **Harness requirement:** the
  callback endpoint answers 2xx only **after** the result is durably written, not
  after it was queued — otherwise the ack is false;
- `wait: true` **without** `meta.session_id` (no lock) — implicit ack with the
  response; with `session_id` an explicit `ack` is required: the response may not
  have arrived or may not have been written;
- otherwise — an explicit `POST /runs/{id}/ack` (§4.8) after `GET`, `cancel` or
  `wait`;
- safety net — the run is deleted after `RUN_RETENTION_UNACKED_MS` (the lock is
  released, event `ack_missing`).

While the lock is held, `POST /runs` for the same session → `409 result_pending` with
`pending_run_id`: the harness fetches the result with `GET`, records it, sends `ack`,
retries the `POST`. The lock is a real in-process mutex, so two runs of one session
never overlap and a result cannot fall between two history writes. This is exactly
why a single instance is a deliberate choice (§11.2).

**Layer 2 — a session automaton in the harness.** It covers what the engine cannot
see: `awaiting_tool` can last hours, the engine lock lasts minutes.

```
idle ─────────── POST /runs ──────────────────────► running(run_id)
running ──────── result recorded + ack ───────────► idle
running ──────── awaiting_tool recorded + ack ────► awaiting_tool(run_id, pending_call_ids[])
awaiting_tool ── tool result recorded for every call_id ─► idle ──► POST /runs
```

Rules:

1. **A new run does not start until the previous result is recorded and
   acknowledged.** A user message during `running` → `cancel` (synchronous, returns
   the result) → record → `ack` → `POST /runs`. SSE `done` on the client is **not** a
   signal that history is recorded.
2. No callback by the deadline → `GET /runs/{id}` → record → `ack`; `404` → `lost`,
   session back to `idle`.
3. `awaiting_tool` logically holds the session. A user message in this state: the
   harness closes every pending `call_id` with a synthetic
   `{ role: "tool", call_id, tool, is_error: true, error: "superseded" }`, moves the
   session to `idle` and starts a run with the new message. The business operation is
   **not** cancelled (§6.4); its late result enters the conversation as an `event`
   part of a later `user` message (§5). The old `call_id` is never reused.
4. Several `deferred` calls in one run → continue only after **every** `call_id` has
   a result, with one run, all `tool` messages in a row at the start.
5. **Transactions are optional, idempotent writes are mandatory.** The engine lock
   rules out a second run but not a double write of one result: the callback, `GET`
   and the `cancel` response can reach the harness simultaneously, and a duplicated
   (yet paired) history would pass validation (§5). So everything is written as an
   upsert by deterministic ids:
   - run result — `id = run_id`;
   - message — `id = <run_id>:<seq>` (`seq` is set by the engine on every message it
     produces, §5);
   - tool result — `id = call_id`;
   - `ack` — only after **all** objects and the session state are written.

   If two harness workers both see `running` and both start a run, the second gets
   `409 session_busy | result_pending`; a history with an unresolved `tool_call` gets
   `400 unresolved_tool_call`. Refusals are safe: the worker repairs state and retries.

## 4. HTTP API

All bodies are JSON with `contract_version: "1"` in every request and callback.
Errors are `{ "error": { "code", "message", "retriable" } }` (codes — §12.1). The
maximum size of any incoming request body is `MAX_REQUEST_BYTES` (env, default 1 MB)
→ `413 payload_too_large`.

| Method and path | Caller | Purpose |
|---|---|---|
| `POST /runs` | harness | start a run |
| `GET /runs/{id}/stream` | end-user client, harness | SSE |
| `POST /runs/{id}/cancel` | end-user client, harness | stop, synchronous |
| `POST /runs/{id}/tool-result` | async tool | result of an `accepted` call |
| `GET /runs/{id}` | harness | status / result |
| `POST /runs/{id}/ack` | harness | result recorded, release the session lock |
| `GET /logs`, `GET /runs/{id}/logs` | harness, operator | event journal |
| `GET /health` | anyone | liveness and load |

### 4.1 Auth and egress

- **Harness → engine** (`POST /runs`, `GET /runs/{id}`, `cancel`, `ack`, `GET /logs`):
  `Authorization: Bearer <ENGINE_TOKEN>`. The env variable is required, there is no
  default; several tokens may be given comma-separated (rotation).
- **End-user client → engine** (`stream`, `cancel`): a **run token** — 32 random bytes
  from the `POST /runs` response, valid until the run is deleted, scoped to that run
  only. Passed as `?token=` (EventSource cannot set headers). Responses to `?token=`
  requests carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the
  access log strips query strings. A request to a run route with no credential at all
  (no `ENGINE_TOKEN`, no token) gets `401` before the run is looked up, so an anonymous
  caller cannot tell whether a run exists.
- **Async tool → engine** (`tool-result`): a per-call token embedded in `result_url`
  (§6.1). `ENGINE_TOKEN` is accepted too.
- **Engine → tools / callback / provider**: controlled egress (§11.4): HTTPS only,
  hosts from `EGRESS_ALLOWLIST`, private IPs refused, redirects not followed, only
  `Authorization` and `X-*` headers. The callback is additionally signed with an
  engine secret from env — `X-Engine-Secret` (§7).
- **End-user clients talk to the engine directly**: CORS by `ALLOWED_ORIGINS` (env).
  The harness hands `stream_url` / `cancel_url` with the run token to the client as
  is; no proxy is needed.

### 4.2 `POST /runs` — start a run

```json
{
  "contract_version": "1",
  "idempotency_key": "msg_01J…",
  "history_revision": 12,
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "api_key": "sk-ant-…",
    "base_url": null,
    "context_window_tokens": 200000,
    "capabilities": null,
    "params": { "cache": true },
    "pricing": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75,
                 "per_tokens": 1000000, "currency": "USD", "version": "2026-09" }
  },
  "system": "You are the support assistant of Acme Store. …",
  "messages": [ /* StoredMessage[], §5 — the full history */ ],
  "tools": [
    { "name": "getOrderStatus",
      "description": "Order status by id",
      "input_schema": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] },
      "endpoint": "https://api.example.com/tools/getOrderStatus",
      "headers": { "Authorization": "Bearer …" },
      "timeout_ms": 30000,
      "effect": "read" },
    { "name": "createReturn", "description": "…", "input_schema": { "…": "…" },
      "endpoint": "https://api.example.com/tools/createReturn", "effect": "write",
      "defer_loading": true }
  ],
  "skills": [
    { "name": "order-returns",
      "description": "Return and refund policy. Use when the user asks about a return.",
      "body": "# Returns\n\nCheck the order status first …",
      "tools": ["createReturn"] }
  ],
  "limits": { "max_steps": 8, "max_tokens": 4096, "max_tool_calls": 16,
              "max_total_tokens": 150000, "max_cost": 0.5,
              "timeout_ms": 120000, "tool_result_max_bytes": 32768, "final_answer": true },
  "stream": { "expose_args": false, "expose_result": false, "expose_reasoning": false },
  "callback": { "url": "https://api.example.com/loop/run-result",
                "headers": { "Authorization": "Bearer …" } },
  "wait": false,
  "meta": { "session_id": "sess_…", "user_id": "u_…", "tenant_id": "t_…",
            "assistant_id": "support-v1", "timezone": "Europe/Berlin", "locale": "en" },
  "output_checks": [ { "fence": "action-card", "schema": { /* JSON Schema 2020-12 */ }, "max_repairs": 2 } ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `idempotency_key` | **yes if there are write tools**; otherwise no | Usually the id of the user message. A repeat with the same key while the run is retained → `200` with the same `run_id`, `stream_url`, `cancel_url` (same token), no second execution; the result is read via `GET`. Same key, different body → `409 idempotency_mismatch`. Sent to tools as `origin_request_id` (§6.1). Durable idempotency (after a restart, beyond retention) is the harness's job, by message id. |
| `history_revision` | **yes if there are write tools**; otherwise no | History revision at request time (turn count or session record version). The engine does not interpret it and **echoes** it in the result and `GET`; the harness uses it to place late results (§3). |
| `llm.provider` | yes | From the allowlist, §9.1. |
| `llm.model` | yes | Free-form string, validated by the provider. |
| `llm.api_key` | yes for `openai-compatible` | Overrides env. An env key is used **only** with the built-in `base_url` of a named provider. |
| `llm.base_url` | `openai-compatible` only | HTTPS, host in `EGRESS_ALLOWLIST`. |
| `llm.gigachat_scope` | no | `gigachat` only: `GIGACHAT_API_PERS \| GIGACHAT_API_B2B \| GIGACHAT_API_CORP`. Empty → env `GIGACHAT_SCOPE`. The scope must match the key, otherwise the provider's OAuth refuses (§9.1). Ignored for other providers. |
| `llm.context_window_tokens` | no | Model window for context trimming (§5.1). Absent → built-in model profile; no profile → `MAX_CONTEXT_FALLBACK` (env, 128k). |
| `llm.capabilities` | no | `{ parallel_tools?, usage_in_stream? }` for `openai-compatible`; conservative defaults (§9.2). |
| `llm.params` | no | `temperature`, `top_p`, `stop`, `seed`, `thinking`, `cache` (§9.3). Unknown params → warning, dropped. |
| `llm.pricing` | no | If present, the engine returns `usage.cost` and can enforce `limits.max_cost` (§8.3). |
| `system` | no | Dates are never put here by the engine (§9.4). |
| `messages` | yes | The full history; at least one `user` message. |
| `tools[]` | no | `effect: "read" \| "write"` is **mandatory** (§6.4). `defer_loading: true` hides the tool from the model until a skill or `search_tools` activates it (§6.8). `presents: true` — the harness renders a successful result to the user; counts toward `limits.max_presentations` (§6.9). |
| `skills[]` | no | Up to 64 instruction bundles `{ name, description, body, tools? }` the model loads on demand (§6.8). `name`: `^[a-z0-9][a-z0-9_-]{0,63}$`, unique; `description`: 1 to 1024 characters; `body`: 1 byte to 32 KiB UTF-8; `tools`: names from `tools[]`. |
| `limits` | no | Defaults and server ceilings — §10. |
| `stream` | no | What SSE reveals beyond text (§6.6). Default — nothing. |
| `callback` | no if `wait: true` | Where to deliver the result: `{ url, headers? }`. The callback body is `{ "payload": <result> }` (§7). |
| `wait` | no | `true` → synchronous `200` with the result body (§7); a configured callback is still sent. For tests and curl. |
| `meta` | no; **`meta.session_id` is required if there are write tools** | Passed through to tools and the callback. **Reserved** keys read by the engine: `session_id` (lock, part of the `operation_id` hash), `timezone` (§9.4), `locale` (Appendix B). |
| `output_checks` | no | Up to 4 checks of structured blocks in the final answer: `{ fence, schema, max_repairs?, presents?, interim?, grounded? }` — §5.4. The schema is compiled on receipt: invalid → `400 bad_request` (`output_check_schema_invalid: …`). |

Response `202`:

```json
{ "run_id": "run_01J…", "status": "running",
  "stream_url": "https://loop.example.com/runs/run_01J…/stream?token=…",
  "cancel_url": "https://loop.example.com/runs/run_01J…/cancel?token=…",
  "retention_ms": 600000 }
```

`PUBLIC_URL` (env) is the base for these URLs. `expires_at` is unknown in advance
(retention counts from the end of the run); it appears in the terminal result and in
`GET`.

**Context for write tools.** If `tools[]` contains at least one `effect: "write"`, all
three are required: `idempotency_key`, `meta.session_id`, `history_revision`. Without
them the harness cannot derive `operation_id` (§6.4) or place a late result (§3).
Missing any → `400 write_context_missing` listing the missing fields; no run is
created.

Refusals: `400 bad_request` (including `output_checks`: invalid schema, schema over
64 KB, more than 4 checks, repeated `fence` — §5.4; and, only when the request uses
skills or deferred tools: a `tools[]` entry named `load_skill` or `search_tools`, a
duplicated skill name, a skill listing a tool absent from `tools[]` — §6.8) `| unresolved_tool_call |
history_ends_with_assistant` (§5) `| write_context_missing | provider_not_allowed |
provider_key_missing | egress_denied | unsupported_media_type | image_too_large`,
`401 unauthorized`, `409 session_busy` (+ `active_run_id`, the run is still going)
`| result_pending` (+ `pending_run_id`, the result is not acknowledged, §3.1)
`| idempotency_mismatch` (+ `existing_run_id`), `413 payload_too_large`,
`429 overloaded`, `503 shutting_down`. Every refusal is written to the journal as
`run_rejected` (§12.4).

### 4.3 `GET /runs/{id}/stream` — SSE

Details in §6.6. `?token=` or Bearer; `Last-Event-ID` → replay from the buffer;
several subscribers are fine; after the run finishes and until it is deleted — full
replay and `done`; after deletion — `404`. With `output_checks` in the request the
stream may contain `output_check` events and repair-step deltas (§5.4).

### 4.4 `POST /runs/{id}/cancel` — stop

`?token=` (end-user client) or Bearer. **Synchronous:** aborts the run (§6.5), waits
until it reaches `cancelled` (usually < 1 s, at most 5 s) and returns `200` with the
result body (§7). On an already finished run — `200` with the current result
(idempotent). If 5 s are not enough (a tool holds the connection) →
`202 { run_id, status: "cancelling" }`, the result comes by callback / `GET`. The
callback is sent regardless.

**The body depends on the caller.** With `ENGINE_TOKEN` (harness) — the full §7 body.
With a run token (end-user client) — the same body **without `messages`** and with
`error` **without `provider_body`**, exactly like SSE `done` (§6.6): `messages`
contain tool results and `reasoning` that the stream hides behind `stream.expose_*`,
and returning them to a run-token holder would bypass those flags; a provider error
body may quote the prompt. `tool_calls[]` (call metadata only) stays.

`cancelling` is transient (§3): a repeated `cancel` → `202` again; the session lock is
held; if the abort lost the race to a normal finish, the run stays `completed` with
its original `finish_reason` and `cancel` returns that result. `GET` shows
`cancelling` in the `running` shape.

### 4.5 `POST /runs/{id}/tool-result` — result of an async tool

`?token=<call_token>` from `result_url` (§6.1) or Bearer.

```json
{ "call_id": "call_…", "result": { … } }           or
{ "call_id": "call_…", "error": "…", "is_error": true }
```

| Response | When |
|---|---|
| `200 { "accepted": true }` | accepted for the first time |
| `200 { "accepted": true, "duplicate": true }` | same `call_id` and same body hash — already accepted, no retry needed. Works while the run is retained, including after the terminal status |
| `409 result_mismatch` | same `call_id`, different body — the first result was applied, the second is dropped |
| `409 call_closed` | the call was closed before the result arrived: its `tools[].timeout_ms` expired (the run may still be going) or the run became terminal (cancel / timeout / shutdown) |
| `404 call_not_found` | the run is deleted or the `call_id` is unknown |

### 4.6 `GET /runs/{id}` — status

Bearer. A discriminated union on `status`:

- `running` / `cancelling` — `run_id`, `status`, `meta`, `timing.started_at`, `steps`,
  `usage` so far. No `messages`, `finish_reason`, `finished_at`, `expires_at`.
- terminal — the full §7 body plus `acked: boolean` and the delivery block:

```json
"callback": { "status": "delivered | pending | failed | none",
              "attempts": 3, "last_error": "ECONNREFUSED", "next_attempt_at": "…" }
```

On a non-2xx answer `last_error` is `HTTP <status>: <first 300 chars of the response
body>` (secrets scrubbed): the receiver's reason for refusing lives in the body. The
same value goes to the error webhook (§12.3).

### 4.7 `GET /health`

`{ ok, version, uptime_s, active_runs, retained_runs, shutting_down, provider_throttle }`.
No auth. Answers 2xx as soon as the server listens, without probing providers.

`provider_throttle` — the provider queues (§11.6):

```json
{ "enabled": true,
  "limiters": [ { "provider": "gigachat", "key": "3f9a12c4", "limit": 3, "max": 6,
                  "active": 3, "queued": 5, "cooldown_ms": 640 } ] }
```

Per provider key: `limit` — current AIMD ceiling, `max` — ceiling from env, `active` —
slots in use, `queued` — waiting for a slot, `cooldown_ms` — remaining pause after a
429. `key` is the first 8 hex chars of the key hash, never the key. Idle keys at the
default ceiling are not shown; `limiters: []` — no load.

### 4.8 `POST /runs/{id}/ack` — result recorded

Bearer. The harness confirms the run result is recorded in history (§3.1). The engine
releases the session lock; the run itself stays in memory until retention ends.
Implicit on a 2xx callback (the harness answers 2xx **after** a durable write) and on
`wait: true` **without** `meta.session_id`; in every other case only explicit (§3.1).
Idempotent (`200 { acked: true }`); on `running` / `cancelling` → `409 not_finished`;
deleted run → `404`.

### 4.9 `GET /logs`, `GET /runs/{id}/logs` — event journal

Bearer `ENGINE_TOKEN`. Reads the event journal (§12.4) — memory first, then the disk
journal when `LOG_DIR` is set — for debugging agents, not for recovery: the source of truth
for results is `GET /runs/{id}`.

| Query | Meaning |
|---|---|
| `run_id` | events of one run (taken from the path for `/runs/{id}/logs`) |
| `session_id` | all runs of a session, including `POST /runs` refusals with this `meta.session_id` |
| `event` | comma-separated event names: `event=tool_call,tool_result` |
| `level` | minimum level: `debug` (default — everything) / `info` / `warn` / `error` |
| `since` | `seq` of the last seen entry — returns entries strictly after it (tail) |
| `limit` | default 1000, ceiling 10 000. Without `since` — the last `limit`; with `since` — the first `limit` |
| `format` | `json` (default) or `text` — a human timeline: time, +ms, level, event, fields, indented content |
| `inline_prompts` | `true` (default) — `run_start.content.system` is filled back from its hash; `false` — `system_sha256` only |
| `days` | the disk journal: scan at most this many day files, newest first (default — all retained) |

```json
{ "entries": [ { "seq": 812, "at": "2026-10-05T12:00:00.123Z", "level": "info",
                 "event": "tool_result", "run_id": "run_…", "session_id": "…",
                 "step": 1, "call_id": "c1", "tool": "getOrderStatus", "outcome": "ok",
                 "content": { "result": { "state": "shipped" } } } ],
  "truncated": false, "next_since": 840, "source": "memory",
  "buffer": { "entries": 840, "bytes": 412345, "dropped": 0,
              "oldest_at": "…", "last_seq": 840, "content": true, "disk": false } }
```

`source` — where the entries came from: `memory`, `disk` or `mixed`. Memory is read first;
the disk journal is scanned (newest day first, streaming, with a `run_id` / `session_id`
prefilter) only when memory may not hold the whole range: fewer matches than `limit` and,
for a run, no `run_start` of it in memory; for a tail, `since` older than the oldest entry
in memory. Disk entries carry `boot_id`: `seq` restarts with the process, so `since` means
"after this seq in the current boot", and entries of earlier boots are never returned for
a `since` request. Entries are returned in journal order.

Tail: the next request uses `since=<next_since>`. `GET /runs/{id}/logs` keeps working
after the run is deleted from the registry, as long as its events are in the journal
(memory or disk); neither run nor events → `404 run_not_found`. Responses carry `Cache-Control: no-store`.

## 5. Message format — `StoredMessage`

A versioned DTO of its own — **not** the AI SDK `ModelMessage`. The harness stores it
as JSON and sends it back as is; the engine converts it to the provider format on
every run. Tool calls, tool results and reasoning are part of the history.

```
StoredMessage =
  | { role: "user",      content: ContentPart[], created_at?: string }
  | { role: "assistant", content: AssistantPart[], partial?: true }
  | { role: "tool",      call_id, tool, result?: any, error?: string, is_error: boolean,
                         operation_id?: string, builtin?: true }

ContentPart   = TextPart | { type: "image", url } | { type: "event", name, data }
TextPart      = { type: "text", text }
AssistantPart = TextPart
              | { type: "tool_call", call_id, tool, args, operation_id?: string }
              | { type: "reasoning", text?: string, provider: string,
                  provider_metadata: object }        // opaque, §5.2
```

- Messages produced by the engine carry `run_id`, `seq` (0, 1, 2… in order of
  appearance within the run) and `created_at`. The recommended harness record id is
  `<run_id>:<seq>`, so a repeated write is an upsert (§3.1). The harness MAY add its own
  `id`; the engine ignores it.
- `created_at` on a `user` message (ISO 8601) is when the user sent it. The engine
  shows the model the message date from it (§9.4): the line is identical on every turn,
  so provider caches and signed thinking blocks stay valid. Without it, the last user
  message gets the current time, which lives for one turn only.
- `builtin: true` on a `tool` message — the engine wrote it for one of its own tools
  (`load_skill`, `search_tools`, §6.8). It is the only thing that makes such a pair a built-in one; the
  harness stores it with the rest of the message (H20). `false` or `null` are accepted and
  mean the same as absent, as does `null` for `tools[].defer_loading`.
- `partial: true` — the answer was cut (cancel / timeout / shutdown / limit). It goes
  into the next run as is.
- An `event` part in a `user` message is how the harness delivers an event outside the
  user's words: a late operation result after `superseded` (§3.1), a scheduled trigger,
  a system notification. The model sees it as text `[event <name>] <JSON data>`; the
  harness UI renders it its own way.
- **Invariant:** every `tool_call` has a paired `tool` message with the same `call_id`.
  The engine keeps it on cancel and limits (§6.5, §10.1); a run started with a broken
  invariant → `400 unresolved_tool_call`. The only exception is continuing
  `awaiting_tool`: the last assistant message contains a `tool_call` without a result,
  and the **new run MUST start** with a `tool` message for every such `call_id`.
- **The last message** is `user` or `tool`: the model needs something to answer. A
  history ending with `assistant` (text, reasoning, `partial`) →
  `400 history_ends_with_assistant`, no run is created. Usually it means the harness did
  not append the user's message, or a regeneration did not hide the old answer. An
  assistant message with an unresolved `tool_call` at the end is `unresolved_tool_call`,
  checked first.

### 5.1 Context window and trimming

The engine estimates the size of the **whole request**: system + date lines + tool JSON
schemas + history + the `max_tokens` reserve for the answer. The window is
`llm.context_window_tokens`, else a built-in model profile (`claude-*` — 1M, 200k for
`claude-3-*`, Opus / Sonnet 4.0, Opus 4.1 and Opus / Sonnet / Haiku 4.5; `gpt-*`,
`deepseek-*`, `glm-*` — 1M for `glm-5.2` / `5.3*`, 200k for `glm-5` / `5.1` / `4.6` /
`4.7`; `GigaChat*`, `MiniMax-M3*` — 1M, `MiniMax-M2*` — 204 800), else
`MAX_CONTEXT_FALLBACK`. The estimate is a **heuristic**: `chars / 3` for Cyrillic,
`chars / 4` for Latin, `+10 %` margin; an image is 1600 tokens. Code, emoji and dense
punctuation can be underestimated — the margin covers that.

Does not fit → drop the oldest messages, as `tool_call` + `tool` pairs together with the
`reasoning` of the same turn; the first `user` message, the last 4 messages and the turns
that carry a skill activation in effect (§6.8) always stay. With skills, `system` includes
the skill index and only the visible tools are counted. Trimming changes the prefix that
signed Claude thinking blocks are bound to; the engine asks the provider to drop the stale
ones (§9.3). The result carries `context_trimmed: true`. If the provider still answers
"context too long" → `failed / context_too_large`, no automatic retry. Summarization is
out of scope (§15). How much context is used after the run and which window the engine
assumed — `result.context` (§7).

### 5.2 Reasoning and provider state

Anthropic thinking (extended and adaptive) with tools requires thinking blocks to be
returned **with their signature**, unchanged, when a tool-use turn continues. `deferred`
splits such a turn into two runs, so reasoning is **stored** in the history as a
`reasoning` part: `text` (may be absent if the provider redacts it), `provider`,
`provider_metadata` (signature and the rest — opaque). The engine passes it back to the
provider as is through AI SDK `providerOptions`. A different provider — the part is
skipped.

`provider` is the engine provider id (`llm.provider`), not the SDK adapter. MiniMax uses
the Anthropic adapter, and the SDK files its signature under the `anthropic` key, but in
the history the part is marked `minimax`: a MiniMax signature never goes to Anthropic
and vice versa. The `providerOptions` key on replay is the one the adapter reads.

SSE does not carry `reasoning` unless `stream.expose_reasoning` is set. The harness
stores the part and decides whether to show `text`.

An unfinished reasoning block (cancel / interruption mid-thinking) without a valid
signature is **not stored** — the provider would reject such a replay.

### 5.3 Images

`{ type: "image", url }` is either a `data:` URL (base64; bounded by `MAX_REQUEST_BYTES`
of the whole request, in practice ≤ ~700 KB per image) or an `https://` URL on a host
from `EGRESS_ALLOWLIST` — for anything larger. The **engine downloads it with its egress
client** (§11.4: allowlist, private-IP check, no redirects, a bare `GET` without
headers — the link must be fetchable without auth), body ceiling `IMAGE_MAX_BYTES`
(env, 5 MB), MIME ∈ `image/png | jpeg | webp | gif` (GigaChat: `png | jpeg` only, see
below), and hands the bytes to the provider. SDK adapters are never allowed to fetch
URLs themselves. Errors: at request validation — `400 egress_denied` (host),
`400 unsupported_media_type` (`data:` with a foreign MIME), `400 image_too_large`; during
the run — `failed / image_fetch_failed` (network, MIME or size of a remote image). The
egress client has body limits **per purpose**: tool response — `TOOL_RESPONSE_MAX_BYTES`,
image — `IMAGE_MAX_BYTES`, callback response — 64 KB.

**How to send.** An image is a part of a `user` message next to text; the model sees the
parts in their order:

```json
{ "role": "user", "content": [
    { "type": "text",  "text": "What is wrong on this screen?" },
    { "type": "image", "url": "https://<host from EGRESS_ALLOWLIST>/…/screen.png" } ] }
```

Image only — `content` with a single `image` part. Several images — several parts. An
image stays in the history and goes to the provider on every subsequent run
(≈ 1–1.6k tokens each per turn). Replacing old images with text is the harness's call;
the engine never rewrites history.

**Who can see.** Current Anthropic and OpenAI models. GigaChat — `GigaChat-2-Pro` and
`GigaChat-2-Max`; Lite (`GigaChat-2`) answers `422 Model does not support image` →
`failed / provider_error` with the provider body in `provider_body`. The engine does not
check models for vision: the provider's answer is passed through.

**GigaChat** accepts images only as files. The engine uploads the image to the provider
storage (`POST /files`, multipart, `purpose=general`) and sends the id in the message's
`attachments`, with `content` as a string (§9.1). The provider allows one image per
message, so a `user` message with N images is split into N consecutive `user` messages:
a new one starts at each subsequent image, text stays where it was (the model sees all
of them). An image is uploaded **once per run** (loop steps reuse the id) and **deleted
at the end of the run** (`POST /files/{id}/delete`, best-effort, event
`gigachat_files_deleted`, §12.4). The next run uploads it again under a new id; the
provider's cache is bound to the file id, so within a run the image is served from cache
and in a new run it is paid again.

- MIME — `png | jpeg` only: the provider refuses webp and gif at upload, the engine
  refuses them earlier — `400 unsupported_media_type` for `data:`,
  `failed / image_fetch_failed` for https.
- Provider ceilings: 10 images per request and 15 MB per image (ours is lower:
  `IMAGE_MAX_BYTES`). The engine does not cut at ten; if the provider starts refusing,
  it is `failed / provider_error` with its body. Watching the image count in history is
  the harness's job.
- An upload refusal is the answer of that provider attempt and is classified like any
  provider answer: `400 File format is not supported` → `failed / provider_error`, no
  retry; `429`, `5xx` and network → the attempt is retried (§11.3).

### 5.4 Structured blocks in the answer — `output_checks`

A common pattern: the model ends its answer with a structured fenced block — say,
```` ```action-card ```` with JSON — and the client renders it as a card with a button.
A broken block (merged fields, an invented enum value, an object instead of a list)
shows up as a broken card. Weaker models break such blocks often. The gate catches a
broken block inside the same run and lets the model fix it. The engine knows nothing
about specific block types: the fence and the schema come in the request.

```json
"output_checks": [ { "fence": "action-card", "schema": { … JSON Schema 2020-12 … }, "max_repairs": 2 } ]
```

| Field | Meaning |
|---|---|
| `fence` | Fence label, `^[a-z0-9-]{1,40}$`. Unique within the list. |
| `schema` | JSON Schema 2020-12, serialized size ≤ 64 KB. Compiled on receipt: ajv `Ajv2020`, `allErrors`, `discriminator`, `strict: false`. Does not compile (including an unresolvable `$ref`, a foreign `$schema`, `$async`) → `400 bad_request`, `output_check_schema_invalid: <fence>: <reason>`; over 64 KB → `output_check_schema_too_large`. `format` is not validated. |
| `max_repairs` | Repair steps: default 1, ceiling 3 — higher values are clamped like §10 limits. `0` — check only: a broken block is cut without repair. |
| `presents` | `true` — the harness renders a block of this fence to the user: a `passed` / `repaired` block counts toward `limits.max_presentations`, and is cut once the budget is spent (§6.9). Default `false`. |
| `interim` | `keep` (default) or `drop` — blocks of this fence in the text of a tool step (below). |
| `grounded` | Up to 8 `{ path, tools }`: values at `path` must come from `ok` results of `tools` (below). |

At most 4 checks. **Without `output_checks` the engine behaves exactly as if the feature
did not exist**, and the result has no `output_checks` field.

**When.** Only at the moment the run would otherwise finish `completed / end_turn`: a
step without tool calls and not cut by `max_tokens`. Intermediate steps with tool calls
are not checked; with `interim: "drop"` their blocks are removed instead. A run that never reaches that moment (`stopped_limit`,
`awaiting_tool`, `failed`, `cancelled`) returns `output_checks: []`.

**How the block is found:**

- opening — a line that, after whitespace, starts with ```` ```<fence> ```` followed by
  nothing or a space and an info string without backticks: an inline
  ```` ```action-card``` ```` is not a block, ```` ```action-card-v2 ```` is a different
  fence;
- closing — a line of ```` ``` ```` and whitespace;
- the **last** block of the fence is checked (models sometimes repeat the answer with
  the block twice; clients render the last one). An unclosed last block is a failure
  (`block_unclosed`);
- before `JSON.parse` the GigaChat service token `<|superquote|>` is replaced with `"`.

No block → `absent`, nothing happens. Valid → `passed`, the text is untouched.

**Repair.** JSON does not parse or the schema returns errors, and repairs remain:

1. One more model step with `tool_choice: none`. The provider history gets the model's
   answer as is plus a synthetic `role: user` message (GigaChat allows a single system
   message, §9.4) in the run locale (Appendix B):

   ```
   [Format check] The action-card block failed validation:
   - /actions/0/kind: must be equal to one of the allowed values: "link", "reply"
   Send only the corrected ```action-card``` block, with no text before or after.
   ```

   At most 8 error lines, deepest paths first; invalid JSON is a single line
   `JSON did not parse: …`. `allErrors` on `oneOf` / `anyOf` reports errors of every
   branch, which confuses models even more, so branches are collapsed into one: "exactly
   one field from the list" is named directly (for `oneOf` the first branch, the primary
   form, is named), a branch of another type is dropped, umbrella errors (`oneOf`,
   `anyOf`, `if`, `discriminator`) above concrete ones are removed. Shape errors
   (`required`, `minItems` / `maxItems`, `oneOf`…) get the `description` of the nearest
   described subschema appended, except the root, once per message.
2. The next attempt sees the whole chain: answer, synthetic 1, draft 1, synthetic 2…
   An empty draft is not added to the chain.
3. In a repair answer the last block is taken again. No block is a failed attempt too
   (`block_missing`).
4. Repair steps do **not** count toward `max_steps` and `timing.steps`, but do count
   toward `usage.calls[]` (§8), the `max_total_tokens` / `max_cost` budgets (checked
   before every attempt, §10.2) and `timeout_ms`.
5. The budget denies the next attempt, `timeout_ms` expires, the provider fails (after
   its own retries, §11.3) — repair stops and the run finishes **normally**:
   `completed / end_turn` with `error: null` — the answer exists, only the block is
   broken. `cancel` / shutdown during repair → `cancelled / user | shutdown` with the
   same final message, without `partial` (the original answer was complete).

**The final message** of the run (in `messages`, the callback, `GET`) is **one**
assistant message in place of the original, same `seq`:

- `absent` / `passed` — unchanged;
- `repaired` — the original text with **all** blocks of the fence removed, plus the
  repaired block at the end after a blank line (`<|superquote|>` already replaced);
- `failed` — the original text without blocks of the fence: the user sees an answer
  without a card instead of an error. If the answer contained nothing but the block, the
  message is not stored: providers reject an assistant message without content on the
  next run.

Several fences are checked and repaired independently, in `output_checks` order;
repaired blocks are appended in the same order. Text parts are merged into one,
`reasoning` stays. Repair synthetics and drafts **never** enter `messages` — only the
journal; the §5 invariant is untouched: the final message has no tool calls.

**SSE** (§6.6). Repair deltas continue the same assistant answer, preceded by a
`delta "\n\n"` separator (otherwise the closing fence of the old block would merge with
the opening of the new one). A `tool_call` in a repair step (the provider ignored
`none`) is neither streamed nor executed. Event `output_check` —
`{ fence, attempt, status, errors? }`:

| `status` | `attempt` | When |
|---|---|---|
| `passed` | 0 | the original block is valid |
| `repairing` | number of the repair starting | before a repair step; `errors` — error paths being fixed |
| `repaired` | number of the successful repair | the repaired block is valid |
| `failed` | repairs made | gave up; `errors` — error paths of the last attempt |
| `suppressed` | 0 | a presenting block after the presentation budget is spent: cut, not repaired (§6.9) |
| `dropped` | 0 | `interim: "drop"` removed blocks from a tool step; carries `step` |

`absent` is not streamed. `errors` are paths only (`/actions/0/kind`, `/` for the root)
or `json` / `block_unclosed` / `block_missing`. After a failed repair the SSE text also
contains the drafts — the truth is the final message; `output_check failed` is the
signal for the client.

**Result** (§7) — `output_checks: [{ fence, status, attempts, errors?, reason? }]` in
request order:

| Field | Meaning |
|---|---|
| `status` | `absent \| passed \| repaired \| failed \| suppressed` — `suppressed`: cut by the presentation budget (§6.9), the text stays |
| `attempts` | repair steps made (0 for `absent` / `passed` and when repair never started) |
| `errors` | for `repaired` and `failed` — errors of the **original** block as `path: message` strings (≤ 8): what the model broke, for analytics |
| `reason` | for `failed`: `repairs_exhausted \| max_total_tokens \| max_cost \| run_timeout \| provider_failure \| cancelled`; for `suppressed`: `presentation_limit` |

**Journal** (§12.4) — an `output_check` event for every gate decision.

**Interim blocks** (`interim: "drop"`). A block of the fence written in a step that ends
with tool calls answers a question the step has not finished asking — the tool results may
change it — and, kept in the history, it is an example the model copies on every following
step. When such a step finishes, every block of the fence in its text, closed or not, is
removed (block detection as above); the surrounding text stays, and if nothing but
whitespace remains the stored assistant message carries only its tool calls. The cleaned
text is what goes into `messages` and what the provider sees on the next step; the original
is in the journal (`interim_block_dropped`). Nothing is repaired: the final answer is where
the block belongs, and where the gate checks it. The text was already streamed: right
after the step's `step` event SSE gets `output_check { fence, attempt: 0, status:
"dropped", step }`; a client that renders from the final message does nothing.

**Grounded values** (`grounded`). The schema can say "two digits"; it cannot say "a value
some lookup returned". `grounded: [{ path, tools }]` — `path` is a JSON Pointer into the
block, `*` matching every array index or object key at that level; `tools` — tool names. A
scalar at `path` is grounded if it equals a scalar found anywhere in an `ok` result of one
of those tools, in the request history or in this run so far (results truncated by
`tool_result_max_bytes` are searched as truncated). Values compare as strings after
`String()`, exactly. Objects and arrays at `path` are skipped — point at the scalars; a
path that matches nothing passes (presence is the schema's job). Checked after the schema
passes; an ungrounded value is a validation error and goes through the repair above with
the line, in the run locale, `- /codes/0: "91" is not among the values returned by
lookup_area`. Repair steps have no tools, so the model must use a returned value or drop
the item. The journal reports such a verdict as `outcome: ungrounded`. It is a provenance
check, not a semantic one; ids the engine never saw in a tool result belong in the
schema as an `enum`.

**Accepted risk.** A `pattern` in the schema is a regular expression executed on model
output. The harness is trusted (`ENGINE_TOKEN`) and the answer is bounded by
`max_tokens`, but a catastrophically backtracking regex in a schema will hang the
process.

## 6. Tools

### 6.1 The call

```
POST {tools[].endpoint}
{ "contract_version": "1", "run_id", "call_id", "attempt": 1,
  "origin_request_id": "msg_01J…",
  "tool": "getOrderStatus", "args": { "orderId": "…" }, "meta": { … from the request … },
  "result_url": "https://loop.example.com/runs/run_01J…/tool-result?token=<call_token>" }
```

`origin_request_id` = the request's `idempotency_key` (the user message id): one user
intent — one id, no matter how many runs process it. For write tools it is the input to
the operation's business logic (§6.4). `attempt` is the transport retry number
(1, 2, 3).

**An invalid call is not executed.** Before calling the endpoint the engine checks the
call: did the arguments parse, does the tool exist in `tools[]`, do `args` satisfy
`input_schema` (conservatively — `type`, `required`, `enum`; unknown schema constructs
are skipped). If not, the endpoint is **not called**; the model gets
`{ is_error: true, error: "invalid_tool_input: <reason>" }` and may rephrase;
`tool_calls[].status = error`. Without this check a write endpoint would receive a call
with missing fields and create a half-baked operation (§6.4). Rejected calls do not
count toward `duplicate_write_intent` (§6.3) — they never reach an endpoint.

A call to a deferred tool the model cannot see yet is refused the same way with
`tool_not_loaded: …` (§6.8).

`call_id` is unique within the run and serves as **transport** idempotency: an engine
retry on network / 5xx uses the same `call_id`, and the tool may return its previous
answer. **`call_id` is not stable across runs** — after a crash and a retry there will
be a new one. Business idempotency of mutations lives in the harness, on `operation_id`
(§6.4).

### 6.2 Tool response

| Response | Engine |
|---|---|
| `2xx { "status": "ok", "result": … }` | result → model |
| `2xx { "status": "error", "error": "…" }` | tool error → model, the loop continues |
| `2xx { "status": "accepted" }` | wait for `POST result_url` up to `tools[].timeout_ms` |
| `2xx { "status": "deferred", "operation_id": "…" }` | the run ends `awaiting_tool` (§6.4); `operation_id` is written into the `tool_call` part |
| `2xx` any other body | the whole body = `result` (endpoints are not forced to wrap) |
| network / 5xx | retried ×2 with the same `call_id` (1 s, 3 s), then a tool error |
| 4xx | tool error, no retry |
| egress refused (host not in the allowlist, a private address after DNS, §11.4) | tool error `egress_denied: …`, no retry — the answer is deterministic |
| timeout (including waiting for `accepted`) | `tool_timeout` → tool error |
| a write tool answered anything but `deferred` | `tool_protocol_error` → tool error, endpoint logged |

The tool response body is read as a stream with the ceiling `TOOL_RESPONSE_MAX_BYTES`
(env, 1 MB): larger → the connection is dropped, tool error `tool_response_too_large`. A
successful result is then cut to `limits.tool_result_max_bytes` with the marker
`…[truncated, N bytes total]` and `truncated: true`.

A tool error **does not fail the run**: the model gets `{ is_error: true, error }` and
decides. A run fails only because of the provider, the run timeout or the context.

**Empty result** — an empty body, `null`, a missing `result` with `status: ok`, a
whitespace string, `[]` or `{}`. A bare `null` or empty string reads to a model as "the
call did not work", and it repeats the call until `max_steps`. So when the prompt is
built, such a result is shown to the model as an explicit text marker in the run locale
(Appendix B): *the tool succeeded and returned an empty result — there is no data;
calling it again with the same arguments returns the same*. In `StoredMessage` and the
callback `result` stays as received (`null`, `[]`, …), `tool_calls[].status = ok` — the
marker lives only at the provider boundary and applies equally to the history of past
runs.

### 6.3 Parallel calls

The model produced several tool calls → they run in parallel if the provider supports
it (§9.2), otherwise sequentially; all are awaited. A mixed batch (`ok` + `deferred`) →
the run ends `awaiting_tool` only after all in-flight calls finish; sync results go to
the history as usual. Results are written to the history and `tool_calls[]` **in the
order of the model's tool calls**, not in HTTP completion order. Batch limits — §10.1.

**Two or more calls of the same write tool in one step** → none of them is executed:
they share `(session_id, tool, origin_request_id)`, and parallel upserts with different
`args` would produce an operation with last-writer-wins fields. Each gets a synthetic
`tool` with `is_error: true, error: "duplicate_write_intent"`,
`tool_calls[].status = duplicate_write_intent`; the model must assemble one consistent
call. Read tools are unaffected.

### 6.4 `effect`: read vs write, `deferred`, approvals

`tools[].effect` is mandatory:

- **`read`** — no business effect. Answers synchronously (`ok` / `error` / `accepted`).
  Repeating it is safe.
- **`write`** — a mutation. **Calling a write endpoint only registers an intent**: the
  endpoint creates or finds an operation, answers `deferred` with an `operation_id` and
  **changes nothing**. The mutation itself happens in the harness separately — after the
  operation is durably recorded and approved — and never inside a tool call. A sync
  answer from a write tool is a `tool_protocol_error` (§6.2): a detector of a
  misconfigured tool, not a safeguard — if the endpoint already changed something and
  answered `ok`, the engine cannot undo it. This is why a retry after a crash, or a
  cancel during a mutation, never causes a second execution: the engine never runs
  mutations, it only requests them.

  **How the harness decides whether it is the same operation or a new one — strict
  order:**

  1. **Look up by `origin_request_id`** — through a reference object
     `opref_<sha256(session_id | tool | origin_request_id)>` → `operation_id`, among
     operations of **any status**. Found → answer `deferred` with the existing
     `operation_id` — **always `deferred`**, even if the operation already executed (a
     write endpoint never answers with a sync result, §6.2); the harness then
     immediately continues the conversation with a new run carrying the ready result.
     Replaying a lost run with the same user message **never** creates a second
     operation.
  2. Not found → **business comparison with the open (`pending`) operations of this tool
     in the session** by subject fields (for a payment — payee, amount; for a booking —
     resource, date). Match → the same `operation_id`, no second approval card; fields
     changed → update the pending operation and bump `operation_version`. **Always**
     write the reference `opref_<sha256(session_id | tool | origin_request_id_B)> →
     operation_id_A` — otherwise, after A closes, a replay of request B will not find it
     by its origin and step 3 will create a second operation.
  3. Otherwise — create the operation `op_<sha256(session_id | tool | origin_request_id)>`
     and its `opref`.

  Uniqueness rests on **deterministic object ids**: a write by an existing id is an
  upsert, so two concurrent creates (a transport retry, a parallel call) converge into
  one object without a separate lock. A separate `opref` object instead of an alias
  array inside the operation — because concurrent upserts of one array field lose
  entries. On actual execution `operation_id` is passed to the downstream system (bank,
  payment provider) as **its** idempotency key — a durable record in the harness does
  not by itself protect from a repeated request after a network drop.

  **`operation_version`.** The approval card carries a version (or a hash of the subject
  fields); a confirmation with a stale version is rejected — the user cannot confirm an
  amount the model has already changed with a later request.

  An intentional repeat ("one more just like it") arrives as a new message — a new
  `origin_request_id` — and after the previous operation is closed, step 3 creates a new
  one. Approval always sits on top: no operation executes without explicit
  confirmation.

`deferred` is also the boundary of any long operation (a bank, a document, waiting for a
human). The run ends `awaiting_tool`, the history keeps the `tool_call` with
`operation_id` and no result, the engine forgets the run. When the result is ready, the
harness starts a new run: history + `{ role: "tool", call_id, tool, operation_id,
result, is_error: false }`.

**Approval** is exactly this pattern, entirely in the harness: a tool such as
`issueRefund` creates the operation, shows the user a "confirm?" card, answers
`deferred`; on click the harness executes and continues the conversation with a new run
carrying the result (or `{ is_error: true, error: "rejected by the user" }`). There is
no approval logic in the engine and there will not be.

### 6.5 Stop / cancel

`POST /runs/{id}/cancel` at any moment of `running`:

1. `AbortController` — the provider stream and in-flight HTTP calls to read tools are
   aborted; late `tool-result` posts → `409 call_closed`.
2. Generated text is kept: an assistant message with `partial: true`.
3. Every `tool_call` without a result gets a synthetic
   `{ role: "tool", call_id, tool, is_error: true, error: "cancelled" }`. The §5
   invariant holds. This includes a write call that already answered `deferred` while
   another call of its batch was still running: the run does not end `awaiting_tool`, so
   no continuation will bring that result. Its `tool_calls[]` entry keeps the
   `operation_id` with `status: "cancelled"`, and the harness cancels the operation (H21).
   The same holds for any other terminal status reached with a deferred call open
   (`run_timeout`, an engine failure).
4. Usage: finished attempts — exact; the interrupted one — `unknown` with an estimate
   (§8.2).
5. SSE `done { status: "cancelled" }`; `cancel` returns the §7 result; the callback is
   sent regardless.

A read call that already reached its endpoint cannot be recalled — it finishes for
nothing. Write tools are never synchronous (§6.4), so cancel never "loses" a mutation.

**A new user message during generation** (the "interrupt" UX): the harness calls
`cancel`, receives the result synchronously, appends its messages to the history, then
`POST /runs` with the new message. There is deliberately no atomic `preempt`: the
history snapshot in the new request could not contain the partial answer of the old
run, and two callbacks could arrive in any order.

The same abort mechanism serves the run timeout (`failed / run_timeout`, partial kept),
shutdown (§11.1) and limits (§10.1).

### 6.6 SSE stream

```
id: 17
event: delta
data: {"text":"Order 12345 "}
```

| event | data | by default |
|---|---|---|
| `start` | `{ run_id, provider, model }` | yes |
| `delta` | `{ text }` | yes |
| `tool_call` | `{ call_id, tool }` (+ `args` with `expose_args`) | yes, without `args` |
| `tool_result` | `{ call_id, ok, truncated }` (+ `result` with `expose_result`) | yes, without `result` |
| `reasoning` | `{ text }` | only with `expose_reasoning` |
| `snapshot` | `{ through_event_id, text, tool_calls: [{ call_id, tool, status }], step }` (+ `reasoning` with `expose_reasoning`, + `output_checks: [{ fence, attempt, status }]` with the §5.4 gate) — accumulated state **up to and including event `through_event_id`** | on connect without `Last-Event-ID`, or with an id outside the buffer window |
| `step` | `{ index, finish_reason, usage }` | yes |
| `output_check` | `{ fence, attempt, status, errors? }` — format gate (§5.4) | yes, if the request has `output_checks` |
| `done` | `{ status, finish_reason, usage, error? }` — `error` without `provider_body` (§7) | yes |

- By default only text and anonymized progress go out: tool results may contain tenant
  data that the model may use but the user should not see in full. Revealing more takes
  explicit `stream.expose_*` flags.
- Monotonic `id`; the run's event buffer lives in memory until the run is deleted, with
  the ceiling `SSE_BUFFER_MAX_BYTES` (env, 2 MB per run) — older events are evicted
  beyond it. A subscriber with a `Last-Event-ID` inside the buffer window → exact replay
  of the tail. Without `Last-Event-ID`, or with an id outside the window → `snapshot`
  with the watermark `through_event_id = N`, then **only** events with `id > N` — no
  duplicated text; `{ event: "gap" }` precedes `snapshot` if some events were already
  evicted. After the terminal status the buffer collapses into `snapshot + done` (§11.5).
- Backpressure: a subscriber that falls behind the live stream by more than
  `SSE_BUFFER_MAX_BYTES` is disconnected and comes back with `Last-Event-ID`. The initial
  burst (`gap`, `snapshot`, replay, `done`) does **not** count toward the lag and is sent
  in full — otherwise a `snapshot` bigger than the buffer would break every reconnect
  before `done`.
- `: ping` every 15 s.
- A closed tab cancels nothing; the run finishes and is delivered by callback.
  Cancellation is only an explicit `cancel`.

### 6.7 Repeated calls and loops

A model that did not understand a tool's answer calls it again with the same arguments,
step after step, until `max_steps` runs out: the user waits, tokens burn, no answer. The
engine cuts this without a new status:

1. **A repeat = the same `tool` + the same `args`** (deep comparison, key order
   ignored) as a call of the **previous step** of this run — executed, rejected (§6.1)
   or itself a repeat. Calls from the request history, identical calls within one batch
   and calls refused with `duplicate_write_intent` (§6.3) are not repeats — a consistent
   call may legitimately match one of the refused ones.
2. A repeat is **not executed**: the endpoint is not called, it does not count toward
   `max_tool_calls` or `duplicate_write_intent`. The model gets a synthetic
   `{ is_error: true, error: "repeated_call: …" }` in the run locale (Appendix B) — *this
   exact call was already executed in this run, its result is above; repeating it
   returns the same — use the existing result or answer the user* —
   `tool_calls[].status = error`. The first repeat is a warning: tools stay available,
   the model may change arguments or call another tool.
3. **The second repeat in a run** (`limits.max_repeated_calls`, default 1 forgiven repeat:
   `0` — the first repeat already disables tools, `n` — repeat `n + 1` does, clamped to 3)
   → all following steps go with `tool_choice: none`: the
   model must answer in text with what it has, and the run ends `completed`. For
   Anthropic the request keeps `tools` and carries `tool_choice: { "type": "none" }`;
   for GigaChat and GLM the engine sends no tools on such steps (§9.1) — both accept
   tool pairs in the history without tool definitions. If a provider ignores `none` and still returns tool
   calls, they are handled as usual, bounded by `max_steps`.
4. **The second empty result of the same tool in a run** — empty by §6.2, with any
   arguments, consecutive or not — also switches the following steps to
   `tool_choice: none`. A model that got "no data" twice at best keeps rephrasing until
   `max_steps`. Counted per tool name: one empty result each from different tools does
   not disable tools.

Calls with **different** arguments are not repeats: iterating over queries is
legitimate work, bounded by rule 4 and `max_steps`.

A call refused by the presentation budget (§6.9) is recorded like an executed one:
repeating it is a repeat.

### 6.8 Skills and deferred tools

The model can pull instructions and tools **within a run**, between steps (RFC 0001).
Everything here applies only to a request with a non-empty `skills[]` or at least one
tool with `defer_loading: true`; any other request runs exactly as before.

**Skill index.** The engine appends to `system`, after a blank line, an index of the
skills sorted by name: the header `[engine] Skills. …` (Appendix B) and one line
`- <name>: <description>` per skill. It is stable between turns and sits inside the
cached `system` block (§9.3).

**Built-in tool `load_skill`** `{ "name": string }`, offered when `skills[]` is non-empty.
Built-ins have no endpoint, are never retried or truncated, are `effect: read`, and **do
not count toward `max_tool_calls`**; each still takes a step. Names `load_skill` and
`search_tools` are reserved while the feature is used.

- Known skill → `ok`. The stored `result` is the body, verbatim, in a `tool` message with
  `builtin: true`. The model sees a header, a blank line and the body:
  `[engine] Skill "<name>" loaded. Tools available from the next step: <a>, <b>.`
  Every deferred tool listed in the skill becomes visible **from the next step**.
- Unknown skill → tool error `unknown_skill: <name>. Available skills: …`; the run goes on.
- The same skill twice in a run is a §6.7 repeat. A skill loaded in an earlier run loads
  again normally (`reloaded: true` in the journal).

**Deferred tools.** A deferred tool is validated, egress-checked and executed like any
other once visible; deferral is a context optimisation, not an authorization boundary. A
call to one that is not visible yet is not executed: `tool_not_loaded: <tool> belongs to
skill "<skill>". Call load_skill("<skill>") first.` It does not count toward
`max_tool_calls` and is not a repeat candidate (§6.7), so the same call on the next step,
once the skill is loaded, executes. For a deferred tool in no skill the error points to
`search_tools` instead.

**Built-in tool `search_tools`** `{ "query": string, "limit"?: 1 to 20 }`, offered when at
least one deferred tool is listed in no skill. The engine ranks **every deferred tool**
with BM25 (`k1 = 1.2`, `b = 0.75`) over the tool's name (split on `_`, `-` and camelCase),
its description, and the property names and descriptions of `input_schema`. Tokens are
lower-cased runs of Unicode letters and digits of two or more characters; no stemming, no
stop words. The query is cut to 500 characters. Only positive scores are returned, best
first, ties by name, at most `limit` (default 5). The stored `result` is JSON:
`{ "tools": [...], "in_skills": { "<tool>": "<skill>" } }` — `tools` are matches in no
skill and are activated from the next step; `in_skills` are not activated, the model is
pointed to the skill so the tool arrives with its instructions. The model sees
`[engine] Tools available from the next step: <a>, <b>.` and
`Part of skills, load the skill first: <tool> (<skill>).`; with no match,
`[engine] No tools match "<query>". …` — a text result, not an empty one (§6.2). The same
query again in a run is a §6.7 repeat. The query is model text: in the journal it goes to
`content` only.

**Activation mechanisms**, one per run, chosen from the model (§9.2) and written to
`run_start` as `activation`:

- `tool_reference` — Anthropic models with tool search. Every step carries every tool:
  non-deferred by name (built-ins among them), then deferred by name with
  `defer_loading: true`; `cache_control` goes on the last non-deferred one. A built-in
  result that activates tools is a `tool_result` of `tool_reference` blocks only, one per
  tool; its text follows as a `text` block in the same user turn, after the tool results
  (the API refuses a `tool_result` that mixes `tool_reference` with text). The API expands the definitions inside the conversation, so the
  cached prefix never changes. `tool_choice: none` steps keep the tools.
- `tools_array` — every other provider. A step carries the visible tools by name; an
  activation adds tools to the next step's array (one prefix cache miss). The text is the
  whole `tool_result`.

**Statelessness.** Before step 1 the engine derives what is loaded from `messages`: every
`load_skill` pair whose `tool` message has `builtin: true` and `is_error: false`, whose
skill is still in `skills[]`, makes that skill's deferred tools visible, and so does every
such `search_tools` result for the tools in its `result.tools` that are still deferred in
`tools[]` (`skills_restored`).
Unmarked pairs — an HTTP tool that was called `load_skill` before the harness adopted
skills — stay ordinary history. A marked message with the wrong shape (`args.name` and
`result` must be strings) is ordinary history with a `builtin_history_invalid` warning.
Historical results render deterministically from the stored message and the current
request: byte for byte as in the run that produced them while tools, skills and locale do
not change. Only tools that are deferred in the current request get a `tool_reference`. The body in the history is the body as loaded then; the history is never
rewritten (§9.3). Trimming (§5.1) never drops a turn that carries an activation in
effect, so the model's tools always match the engine's visible set.

### 6.9 Presentations

The harness often renders parts of a run: a tool result as a card deck under the answer, a
fenced block as a card with a button (§5.4). Two of them in one run compete for the same
screen and answer different questions, and a weak model produces exactly that. The harness
marks what is rendered — `tools[].presents`, `output_checks[].presents` — and caps it with
`limits.max_presentations` (integer ≥ 1, no engine default, not clamped). Without the limit
`presents` changes nothing.

A **presentation** is counted when a presenting tool call finishes `ok` (§6.2, an
`accepted` call that resolved `ok` included; errors, rejections, repeats and refusals show
nothing), or when the final answer has a `passed` / `repaired` block of a presenting fence.
`deferred` write tools are not counted: their approval cards are the harness's, and the run
ends `awaiting_tool` anyway.

**Within a step**, presenting calls are admitted in the model's tool-call order up to the
remaining budget, before any endpoint is called; the rest are refused, even if an admitted
one then fails. **Once the budget is spent**, from the next step:

1. presenting tools are left out of the tool list sent to the provider (as §6.7 does for
   providers without `tool_choice: none`); other tools stay. A deferred presenting tool
   activated later (§6.8) stays out too; with `tool_reference` it stays listed, since the
   history may reference it, and is refused all the same;
2. a call to one is refused without calling the endpoint: `{ is_error: true, error:
   "presentation_limit: …" }` in the run locale (Appendix B) — *the user already sees a
   result of this run, answer in text about it* — and `tool_calls[].status =
   presentation_limit`. It does not count toward `max_tool_calls`;
3. a presenting fence in the final answer is cut without repair:
   `output_checks[].status = suppressed`, `reason: presentation_limit`, the rest of the text
   stays.

Tools win over fences by construction: a fence counts only in the final answer, after every
tool step. If a card must win, the harness does not send the competing presenting tool on
that run — `tools[]` is per request, and a tool the model cannot see is a rule it cannot
break. `max_tool_calls` (§10.1) is checked first: a batch over it is not executed, nothing
is counted. The result carries `presentations: [{ kind: "tool" | "fence", name, call_id? }]`
in order, only when `max_presentations` is set.

## 7. Result and callback

`POST callback.url` after the terminal status. **One logical result, at-least-once
delivery:** 5 attempts, per-attempt timeout `CALLBACK_ATTEMPT_TIMEOUT_MS` (env, 10 s),
pauses 2 → 4 → 8 → 16 s on any non-2xx / network error — the whole schedule fits in
≈ 80 s, hence the recommended harness deadline `timeout_ms + 120 s` (§3); duplicates are
possible — the harness deduplicates by `run_id`. Not delivered → event
`callback_failed` (`run_id`, `meta`, status, error — **without** messages); the run stays
in memory until `RUN_RETENTION_UNACKED_MS` for `GET /runs/{id}` (§11.5).

```json
{
  "contract_version": "1",
  "run_id": "run_01J…",
  "status": "completed",
  "finish_reason": "end_turn",
  "history_revision": 12,
  "meta": { "session_id": "…", "user_id": "…", "tenant_id": "…", "assistant_id": "…" },
  "messages": [
    { "role": "assistant", "run_id": "run_01J…", "seq": 0, "created_at": "…",
      "content": [ { "type": "tool_call", "call_id": "call_a1", "tool": "getOrderStatus", "args": { "orderId": "12345" } } ] },
    { "role": "tool", "run_id": "run_01J…", "seq": 1, "created_at": "…",
      "call_id": "call_a1", "tool": "getOrderStatus", "result": { "status": "shipped" }, "is_error": false },
    { "role": "assistant", "run_id": "run_01J…", "seq": 2, "created_at": "…",
      "content": [ { "type": "text", "text": "Order 12345 has shipped …" } ] }
  ],
  "usage": { /* §8 */ },
  "tool_calls": [
    { "call_id": "call_a1", "tool": "getOrderStatus", "effect": "read",
      "status": "ok", "duration_ms": 412, "truncated": false, "operation_id": null }
  ],
  "timing": { "started_at": "…", "finished_at": "…", "duration_ms": 6210, "steps": 2,
              "queue_wait_ms": 0 },
  "expires_at": "…",
  "context_trimmed": false,
  "context": { "used_tokens": 6490, "window_tokens": 32000, "estimated": false },
  "output_checks": [ { "fence": "action-card", "status": "passed", "attempts": 0 } ],
  "error": null
}
```

**The callback body is `{ "payload": <the body above> }`.** The result travels whole in a
single `payload` field:

```json
{ "payload": { "contract_version": "1", "run_id": "run_01J…", "status": "completed", … } }
```

The envelope keeps strict receivers working — low-code endpoints that accept only a
fixed list of writable fields, or refuse top-level arrays (`messages`, `tool_calls`). A
receiver needs exactly one writable field, and new result fields never break it. The
envelope exists **only in the callback body**: `GET /runs/{id}`, `wait: true`, `cancel`
and SSE `done` return the body as is. Deduplication of repeated deliveries happens at the
receiver, by `payload.run_id`.

**Callback signature.** If env `CALLBACK_SECRET` is set, every callback carries the
header `X-Engine-Secret: <secret>`; the receiver compares it with its constant and
rejects a mismatch. This way the receiving secret never travels in the `POST /runs` body
and never sits in the callback URL query (queries end up in proxy access logs). The env
secret wins: a same-named header from `callback.headers` is dropped — a client cannot
spoof the engine signature. `callback.headers` still work and are sent alongside. The
secret never appears in logs, SSE, the result or `GET`. Env not set — no header. Tool
endpoints are **not** covered by the signature — they have their own `tools[].headers`.

- `messages` — **only the new** messages of this run, in order. Old ones are never
  returned.
- `status` / `finish_reason`:
  `completed / end_turn` ·
  `stopped_limit / max_steps | max_tokens | max_tool_calls | max_total_tokens | max_cost` ·
  `awaiting_tool / deferred` · `cancelled / user | shutdown` · `failed / <error.code>`.
- `limit_reached: "max_steps" | "max_tool_calls"` — on a `completed` run whose answer came
  from the text-only final step (§10.1): a limit was hit, and the model still answered.
  Absent otherwise.
- `answer_source: "fallback"` — the last assistant message is the engine's fixed text in
  the run locale (§10.1, Appendix B), not the model's: the final step produced no answer.
  Absent means the model's (`"model"` is never sent). With the final step on
  (`limits.final_answer`, default), `stopped_limit / max_steps | max_tool_calls` always
  carries a non-empty answer; a harness that rendered `stopped_limit` as an error SHOULD
  render that answer instead.
- `error` on `failed`: `{ code, message, retriable, provider_status?, provider_body? }`
  (provider body — the first 2 KB, keys scrubbed). `message` is human-readable, in the
  run locale (Appendix B); `code` is the stable machine field. `provider_body` only with
  `ENGINE_TOKEN` (callback, `GET`, `cancel`): a provider body may quote the prompt, so SSE
  `done` and run-token `cancel` return `error` without it (§4.4, §6.6).
- `tool_calls[].status`: `ok | error | timeout | deferred | cancelled | not_executed |
  presentation_limit | duplicate_write_intent | http_error | protocol_error`.
- `presentations` — what reached the user, in order (§6.9); only with
  `limits.max_presentations`.
- `tool_calls[].builtin: true` — a call of an engine tool (§6.8): `effect: "read"`,
  in-process `duration_ms`. Absent on HTTP tool calls.
- `history_revision` — an echo of the request (§4.2), for ordering late results (§3).
- `output_checks` — the format gate outcome per fence (§5.4). Only if the request had
  `output_checks`; `[]` — the run never reached a final text. Absent otherwise.
- `timing.queue_wait_ms` — total time the run waited for provider slots across all
  attempts (§11.6); included in `duration_ms`. Always present, `0` — no waiting.
- `context` — context fill after the run, always present:
  - `used_tokens` — the full prompt of the last main-step call (`input_tokens +
    cache_read_tokens + cache_write_tokens`) + its `output_tokens` + the §5.1 estimate of
    tool messages appended after it (`not_executed`, `deferred`, results of the last
    step's tools). This is what the next run of this session starts with, before the new
    user message. Repair steps (§5.4) are excluded — their synthetics and drafts never
    enter the history. `failed` attempts (0 tokens) are skipped. No attempt with tokens
    at all (provider refusal, queue, budget before the first call) — the §5.1 estimate
    over `system`, date lines, tool schemas and the whole history, without the answer
    reserve. If trimming (§5.1) happened, the number refers to the trimmed prompt — what
    the model actually received. Anthropic `reasoning` is part of `output_tokens` and of
    this number.
  - `window_tokens` — the model window used for trimming (§5.1):
    `llm.context_window_tokens`, else the model profile, else `MAX_CONTEXT_FALLBACK`.
    Trimming triggers before `used_tokens` reaches the window: the estimate includes the
    `max_tokens` reserve.
  - `estimated` — `true` if any term is an estimate rather than provider numbers (an
    `unknown` attempt, a provider without usage, tool messages after the last call, no
    calls at all).

  `usage.total` is useless for context fill: every loop step resends the whole context,
  so the sum over steps is a multiple of the real prompt.

## 8. Usage and billing

The engine **counts tokens per provider attempt, not money** — unless a price list is
passed (§8.3). Money and tenant quotas belong to the harness.

### 8.1 What is returned

```json
"usage": {
  "calls": [
    { "index": 0, "status": "ok", "provider": "anthropic", "model": "claude-sonnet-5",
      "input_tokens": 1820, "output_tokens": 96,
      "cache_read_tokens": 1500, "cache_write_tokens": 0, "reasoning_tokens": 0,
      "finish_reason": "tool-calls", "duration_ms": 1830,
      "provider_request_id": "req_…", "estimated": false },
    { "index": 1, "status": "ok", "provider": "anthropic", "model": "claude-sonnet-5",
      "input_tokens": 2010, "output_tokens": 214,
      "cache_read_tokens": 1950, "cache_write_tokens": 0, "reasoning_tokens": 0,
      "finish_reason": "stop", "duration_ms": 2410,
      "provider_request_id": "req_…", "estimated": false }
  ],
  "total": { "input_tokens": 3830, "output_tokens": 310, "cache_read_tokens": 3450,
             "cache_write_tokens": 0, "reasoning_tokens": 0,
             "calls": 2, "unknown_calls": 0, "estimated": false },
  "cost": { "amount": 0.017175, "currency": "USD", "pricing_version": "2026-09", "estimated": false }
}
```

- **One record per real provider attempt.** AI SDK retries are disabled
  (`maxRetries: 0`) — the engine retries itself and records every attempt. `status`: `ok`
  (an answer with usage received), `failed` (refused **before** processing:
  401 / 403 / 404 / 400 / 429 with a body — 0 tokens, `estimated: false`), `unknown`
  (network, timeout, 5xx, interrupted stream — the provider **may** have processed and
  billed it; estimated per §8.2, `estimated: true`).
- The harness keeps both `calls[]` (audit) and `total` (accounting). `total` sums `ok` +
  `unknown`; `unknown_calls` is the number of uncertain attempts.
- `input_tokens` is always the **uncached** input. Anthropic reports it that way
  natively; OpenAI includes `cached_tokens` in `prompt_tokens` — the engine subtracts
  them. `cache_read` / `cache_write` are separate, with their own price.
- `reasoning_tokens` — informational; Anthropic includes them in `output_tokens`, and the
  engine does **not** subtract them.
- `provider_request_id` — for reconciling with the provider console.
- Usage is returned for **every** terminal status, including `failed` and `cancelled`.
- Repair steps (§5.4) are ordinary attempts in `calls[]`: they count toward usage, not
  toward `timing.steps`.

### 8.2 Accuracy and `estimated`

| Situation | `status` | Accounting |
|---|---|---|
| An answer with usage received | `ok` | exact |
| The provider refused before processing (auth, bad request, 429 with a body) | `failed` | 0 tokens |
| Stream interrupted (cancel / timeout / shutdown) | `unknown` | `input` — exact if the provider reported it at stream start (Anthropic `message_start`), else estimated from the prompt; `output` — estimated from the received text |
| Network / timeout / 5xx after sending, before the first content event | `unknown` | `input` — estimated from the prompt, `output` — 0; the engine retries (§11.3) |
| Interruption after the first content event (not cancel) | `unknown` | as for cancel; no retry, run → `failed / provider_stream_interrupted` (§11.3) |
| The provider does not report usage in the stream (§9.2) | `ok` | estimate, `estimated: true` |
| Process crash | — | run `lost`, nothing reported (§3) |

Estimates use the §5.1 heuristic, rounded up where possible. The harness stores
`estimated` next to the numbers and shows "≈".

### 8.3 Money (optional)

If the request has `llm.pricing`, the engine computes
`cost = (input·p.input + output·p.output + cache_read·p.cache_read + cache_write·p.cache_write) / per_tokens`
per attempt and in total; for the example above `(3830·3 + 310·15 + 3450·0.3) / 10⁶ =
0.017175`. `pricing_version` is echoed for recalculation. No price list — no `cost` and
no `limits.max_cost`.

### 8.4 Reconciliation

Periodically: `Σ total` of stored run results against the provider's billing. The gap =
`lost` runs + `unknown` attempts + estimation error. A healthy gap is ≤ 2 %; more — look
at `lost` runs and `unknown_calls`.

## 9. Providers

### 9.1 Allowlist by type

`llm.provider` ∈ `anthropic | openai | deepseek | glm | gigachat | minimax | openai-compatible`.
Named providers are defined in code: kind (native `anthropic` / OpenAI dialect), a
**built-in** `base_url`, the env key name, hard caps (§10), capabilities (§9.2), window
profiles (§5.1). `openai-compatible` takes `base_url` from the request (HTTPS,
`EGRESS_ALLOWLIST`) and a **mandatory** `api_key` from the request: env keys are never
used with an arbitrary `base_url`.

Key resolution: `llm.api_key` → else the named provider's env key → else
`400 provider_key_missing`. **Keys never reach logs, SSE, the callback or error bodies.**

**GigaChat (Sber).** `api_key` is the "authorization key" (Basic); the engine obtains the
OAuth token itself (`POST ngw.devices.sberbank.ru:9443/api/v2/oauth`, ≈ 30 min). Scope —
`llm.gigachat_scope`, else env `GIGACHAT_SCOPE`: key and scope are a pair, a corporate key
with `PERS` does not authorize. Tokens are cached in memory per key + scope and refreshed
a minute before expiry; parallel runs on a cold cache share one OAuth request
(single-flight — the endpoint is rate-limited); OAuth errors are not cached. A `401` from
the API means the token was revoked early: the cache is reset and the request is repeated
**once** within the same provider attempt (no content yet, one attempt in usage); a
second `401` is an ordinary provider error. A refusal of OAuth itself (`400 / 401 /
403`) means a broken key or a mismatched scope: repeating is pointless, the attempt is
`failed / provider_auth`, `retriable: false`, the provider's answer (first 512 bytes —
the reason is there) goes to `error.message` and `error.provider_body`. OAuth `429 / 5xx`
are retried as usual.

GigaChat tools go **through a translator**. Its OpenAI compatibility is partial: the
`tools` field is accepted with `200` and **silently ignored** (verified on `GigaChat-2`,
`-Pro`, `-Max`) — the model answers "no access" or invents the tool result. Only the
native format works, so a fetch wrapper rewrites `chat/completions` both ways and the loop
never knows:

| OpenAI dialect (AI SDK) | GigaChat |
|---|---|
| `tools[].function` | `functions[]` |
| `tool_choice`: `auto` / `required` / named / `none` | `function_call`: `auto` / `auto` / `{ name }` / functions not sent |
| `assistant.tool_calls[].function.arguments` — a string | `assistant.function_call.arguments` — an **object** |
| `role: tool`, `tool_call_id` | `role: function`, `name`; `content` — valid JSON (bare text is wrapped as `{ "result": … }`) |
| `finish_reason: tool_calls` | `finish_reason: function_call` |
| `usage.prompt_tokens` includes `cached_tokens` | `prompt_tokens` **without** cache + `precached_prompt_tokens` |
| `user.content` — an array of parts (`text`, `image_url` with `data:`) | `content` — a string (texts joined by a blank line), an image — `attachments: [id]` from `POST /files`, one per message (§5.3) |

One function per answer (no parallel tools); in the stream `function_call` arrives as one
chunk with a complete object. The translator generates `call_id`. `functions_state_id` is
not stored — the "call → result → answer" cycle works without it. A turn with N parallel
tool calls from a foreign history is laid out as N sequential pairs. Models: `GigaChat-2`
(Lite), `GigaChat-2-Pro`, `GigaChat-2-Max`; all support functions, only `-Pro` and `-Max`
support images (§5.3). `GigaChat-3-*` (served from `api.giga.chat/v1`) is not wired yet.
Concurrency is limited per key: about 10 concurrent streams, the 11th gets `429`
immediately; the engine queues with a default ceiling of 6 (§11.6).

GigaChat **caches the prompt within a session** — header `X-Session-ID`. Without it every
request gets its own server-side id and only the prefix common to all requests (the
system prompt) is read from cache, not the conversation history, even byte-identical.
The engine sends the first 32 hex chars of `sha256(meta.session_id)`, or
`sha256(run_id)` without a `session_id`, so at least the steps of one run share the cache.
The hash keeps client ids away from the provider and keeps the header ASCII. Cached tokens
(`precached_prompt_tokens`) are not billed by the provider.

The GigaChat stream is **not token-by-token**: `-Pro` and Lite emit text by phrases (up to
punctuation or a paragraph break), a list without punctuation may arrive as one event;
`-Max` chunks finer. This is provider behavior, not proxy buffering.

TLS: the provider uses certificates of the Russian Trusted Root CA. The CA goes into the
Docker image + `NODE_EXTRA_CA_CERTS`; `rejectUnauthorized: false` is forbidden.

**MiniMax** — an Anthropic-compatible API, `https://api.minimax.io/anthropic/v1`, the
`@ai-sdk/anthropic` adapter, key in `x-api-key`. This is the API MiniMax recommends:
signed thinking blocks (interleaved thinking — the model thinks between tool calls, the
blocks must be returned in the history, §5.2), `cache_control`, Anthropic-style usage
(`input_tokens` without cache, `cache_read_input_tokens` / `cache_creation_input_tokens`).
The OpenAI-compatible API is not used: there, M2.x thinking sits in `content` inside
`<think>` by default — it would leak into the user's answer, and the openai-compatible
adapter does not return reasoning to the history. The host for China-platform keys
(`api.minimaxi.com`) is not wired — keys do not carry over between platforms.

| Model | Window | Images | Thinking |
|---|---|---|---|
| `MiniMax-M3` | 1M | yes | off; `thinking` → on (`adaptive`) |
| `MiniMax-M3.1-Flash-Preview` | 1M | yes | always; subscription plans only for now |
| `MiniMax-M2.7`, `-M2.7-highspeed` | 204 800 | no | always, cannot be disabled |
| `MiniMax-M2.5`, `-M2.1`, `-M2` (+ `-highspeed`) — legacy | 204 800 | no | always |

`highspeed` is the same model on faster hardware, twice the price for input and output.
Thinking counts toward `max_tokens`: with a small limit M2.x return `length` with empty
text — use `limits.max_tokens` of 16k or more for MiniMax. MiniMax ignores `stop[]`
(`stop_sequences`, `top_k` are unsupported). `temperature` — `[0, 2]`, `1` recommended;
the SDK does not send it when thinking is on. Images — M3 / M3.1 only (JPEG, PNG, GIF,
WEBP); M2.x refuse images with a provider error.

**GLM (z.ai)** — an OpenAI-compatible API, `https://api.z.ai/api/paas/v4`
(pay-as-you-go). Coding-plan endpoints (`/api/coding/paas/v4`, `/api/anthropic`) are not
used: that subscription is for developer tools, not products. Thinking arrives in
`reasoning_content`; the openai-compatible adapter puts it into a `reasoning` part and
returns it in the same field on the next step — which is what z.ai requires for
interleaved thinking with tools (§5.2). `clear_thinking` is left alone: on the standard
API reasoning of past turns is dropped by default. `tool_choice` on z.ai is effectively
`auto` only: `glm-4.7` and `glm-5.3` answer `none` with text, but `glm-5.3-flash` still
calls tools, so `tool_choice: none` steps (§5.4, §6.7) go to GLM without tools at all — a
history with tool calls and no `tools` is accepted. `temperature` — `[0, 1]`, default `1`;
`stop[]` — a single word; `finish_reason: sensitive` (content filter) is reported by the
SDK as `unknown`. Images — vision models only (`glm-4.6v`, `glm-5.3-flash*`), MIME png /
jpeg. z.ai limits concurrency per account tier — `429` already at 5+ concurrent calls on
some tiers; the default `PROVIDER_MAX_CONCURRENCY_GLM` is 4 (§11.6).

| Model | Window | Images | Thinking |
|---|---|---|---|
| `glm-5.3` | 1M | no | always; depth `low` / `high` / `max` |
| `glm-5.3-flash`, `-flashx` | 1M | yes | always; depth `low` / `high` / `max` |
| `glm-5.2` | 1M | no | can be disabled; depth since 5.2 |
| `glm-5`, `glm-5.1`, `glm-4.7`, `glm-4.6` | 200k | no | can be disabled |
| `glm-4.5`, `-air`, `glm-4.7-flash`, `glm-4.5-flash` | 128k | no | can be disabled |
| `glm-4.6v` | 128k | yes | can be disabled |

### 9.2 Capability matrix

| Provider | tools | parallel tools | usage in stream | cache tokens | reasoning |
|---|---|---|---|---|---|
| Anthropic | full | yes | yes | read / write | thinking (signed) |
| OpenAI | full | yes | yes (`include_usage`) | read | reasoning (o-series) |
| DeepSeek | full | yes | yes | read | reasoning (R-series) |
| GLM | full; ignores `tool_choice: none` — such steps go without tools (§9.1) | yes | yes (`include_usage`) | read (automatic) | `reasoning_content`, interleaved |
| GigaChat | full, through the `functions` translator (§9.1) | no | yes (final chunk) | read (`precached_prompt_tokens`, within an `X-Session-ID` session) | — |
| MiniMax | full (Anthropic format) | yes | yes | read / write (`cache_control`) | thinking (signed, interleaved) |
| openai-compatible | as declared | `capabilities.parallel_tools`, default no | `capabilities.usage_in_stream`, default no | — | — |

The engine branches on two axes: parallel tools and usage in stream (otherwise
`estimated`). The rest is informational. One more, internal: **tool references** —
Anthropic models with tool search (Opus / Sonnet / Haiku 4.5 and later, every Fable and
Mythos, later versions of the same lines matched in advance) activate deferred tools
through `tool_reference` (§6.8); every other model, MiniMax included, uses `tools_array`.

### 9.3 Model parameters

`llm.params`: `temperature`, `top_p`, `stop[]`, `seed`, `thinking: { budget_tokens }`,
`cache: boolean` (default `true`). Unknown params → warning, never a failure.

`thinking` is mapped where it exists:

| Provider | What is sent |
|---|---|
| `anthropic` | Opus / Sonnet 4.6, Haiku 4.5 and older — extended thinking with `budget_tokens` as is; newer Claude models (below) — `thinking: { type: "adaptive" }` and `output_config.effort`: `high` for `budget_tokens` ≥ 16000, `medium` ≥ 4000, else `low` |
| `minimax` | `thinking: { type: "adaptive" }`, no budget: turns thinking on for M3, M2.x always think |
| `openai`, `openai-compatible` | `reasoning_effort`: `high` for `budget_tokens` ≥ 8000, else `medium` |
| `glm` | without `thinking` — `thinking: { type: "disabled" }`; for `glm-5.3*` (cannot be disabled) — `reasoning_effort: "low"`; with `thinking` — `{ type: "enabled" }`, plus for 5.2+ `reasoning_effort`: `max` for `budget_tokens` ≥ 16000, `high` ≥ 4000, else `low` |
| `deepseek`, `gigachat` | nothing — reasoning is chosen by the model or its own field; warning `llm_param_unsupported` in the journal, the run proceeds |

**Sampling on newer Claude models.** For `anthropic`, Opus 4.7+ (`claude-opus-4-7`,
`-4-8`, `-5`, `-5-5`), Sonnet 5+ (`claude-sonnet-5`, `-5-5`), Haiku 5+
(`claude-haiku-5-5`) and all `claude-fable-*` / `claude-mythos-*` answer
`400 invalid_request_error` to non-default `temperature` / `top_p` / `top_k` (Haiku 5.5
also to `temperature` together with `top_p`). The engine does not send `temperature` and
`top_p` to these models; the run proceeds, and each dropped parameter is logged as warning
`llm_param_unsupported`. Matching is a regular expression over the model id; newer versions
of the same lines are dropped proactively: an unnecessary drop costs a warning, a miss
costs a failed run. Opus / Sonnet 4.6, Haiku 4.5 and older accept sampling as is. `top_k`
is not supported by the engine at all (an unknown param, §4.2). Style on newer Claude
models is set by the prompt.

**Thinking on newer Claude models.** The same models (same regex) answer `400` to
`thinking: { type: "enabled", budget_tokens }`: they only have adaptive thinking — the
model decides whether and how much to think, depth is set by `output_config.effort`. With
`params.thinking` the engine sends `{ type: "adaptive" }` and the effort derived from the
budget (table above), no warning — the parameter does reach the model. `xhigh` / `max` are
never derived from a budget: `max` spends without a ceiling and `xhigh` is not available
everywhere. Without `params.thinking` nothing is sent and the model default applies: Opus
5.5, Fable and Mythos **always** think (disabling is a `400`); Opus 5, Sonnet 5 / 5.5,
Haiku 5.5 think by default; Opus 4.7 / 4.8 do not. The engine never tries to disable
thinking: where possible, Anthropic advises against it (Opus 5 without it leaks tool calls
into text). Thinking on newer Claude models **counts toward `max_tokens`**, the budget is
not added to the limit — set `limits.max_tokens` generously, 16000 or more. Reasoning text
is not returned by default (`display: "omitted"`): the block arrives signed with empty
text, is stored and returned as is (§5.2), and `stream.expose_reasoning` shows nothing.

**Prompt caching across turns.** The core rule: **the history between turns is only ever
appended to.** Nothing that changes between turns goes into the history or before it —
that breaks the cache, and on newer Claude models also breaks signed thinking blocks
(`400`). Concretely:

- dates go into user messages, not `system` (§9.4);
- tools are sent to the model **sorted by `name`**, not in request order — the order of
  `tools[]` carries no meaning. Anthropic and GLM place tools at the very beginning of the
  prompt, so any permutation resets the whole cache, and harnesses often send tools in
  arbitrary order;
- the engine never rewrites history.

Anthropic and MiniMax: `cache_control` is placed at four points — the Anthropic maximum:

1. the tail of `tools` (the last non-deferred tool by name; deferred tools follow it, §6.8);
2. `system`;
3. the last part of the last user message **before the current-time line** — only if that
   message has no `created_at` (§9.4);
4. the last part of the prompt, unless it is that same message with the current time: a
   message date from `created_at`, tool results on steps within a run, repair synthetics
   (§5.4).

Point 4 is a tail the next step or turn will find unchanged: a history with dates from
`created_at` is only appended to, and the next turn reads everything before it from cache
(the Anthropic lookback is 20 blocks). Point 3 is needed when the tail lives for one turn
only: the next turn arrives with that message without the current time and reads the cache
up to the boundary before it. Only the new user message and its date are paid at full
price; the new history tail is written to cache (×1.25 of input). Other providers cache
the prefix themselves (GLM; GigaChat within a session, §9.1): for them what matters is
only that no changing line sits before the history.

Some prefix changes still reset the cache entirely — changed tool descriptions or a
changed `system` text. The engine does not fix those; the harness makes them for its own
reasons.

**Signed thinking after an engine-made edit.** Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and
Haiku 5.5 (later versions of these lines matched in advance; not Mythos) bind every thinking
block to the exact prefix that produced it: `system`, `tools` and every earlier message.
Replaying a block after that prefix changed is a `400` on accounts Anthropic enforces by
default (created on or after 2026-08-31) and on any request that opts in; on other accounts
the stale block silently reaches the model. Two of the engine's own transforms change the
prefix: trimming cuts turns from the middle and may move the date into `system` (§5.1), and
a user message without a valid `created_at` loses its current-time line once it is no
longer the last one (§9.4). On a step where either happened and the prompt carries
Anthropic `reasoning` after the change, the engine sends `thinking: { type: "adaptive",
block_binding: { prefix_mismatch_behavior: "drop_block" } }` under the
`thinking-binding-controls-2026-08-01` beta. Adaptive is these models' default, so the
thinking mode does not change. The provider drops the first stale block and every thinking
block after it, unbilled, and the step goes on without that reasoning; the count goes to the
journal (`thinking_blocks_dropped`). Edits the harness makes are its own: the engine sends
nothing for them. A harness that sets `created_at` (H2) and a window that fits keep every
block.

### 9.4 Dates and time

Models without a date are useless for anything with deadlines, so the engine always tells
the model the time. Dates go **into user messages, not into `system`**: `system` sits
before the history, and a changing line there breaks the prefix cache right after the
prompt.

**Message date.** Every user message with `created_at` gets a line at its end, in the run
locale (Appendix B): `[engine] Message date and time: 2026-10-12T15:03:21+02:00
(Europe/Berlin).` The line does not depend on the turn, so the history between turns is
only appended to; the provider cache reads it in full and signed thinking blocks stay
valid. The model also sees when each thing was said. An invalid `created_at` → a message
without a date.

**Current time.** If the last user message of the history has no `created_at`, its end
gets `[engine] Current date and time: …` — one line per run, the same for all steps. The
line lives for one turn: it is not in the harness history, and on the next turn the
message arrives without it. For the cache this is a break at that message, for later
thinking blocks — an edit of the history. Harnesses SHOULD therefore send `created_at`.
In a continuation run whose last message is `tool`, the model sees the time of the
question, not the current time. Repair synthetics (§5.4) never become the anchor.

How the line is attached: for Anthropic and MiniMax — as a separate text part, with a
cache point before the current time (§9.3). For the others — appended to the last text
after a blank line: a single-text message stays a string, since not every
OpenAI-compatible API accepts part arrays.

If the history has no user message, or trimming (§5.1) dropped the last one, the current
time goes into `system`. With `cache_control` — as a second system block without cache.
For other providers — inside the same single system message after a blank line: GigaChat
answers `422` to a second system message.

Time zone — `meta.timezone` (IANA), else env `DEFAULT_TIMEZONE`, else `UTC`.

## 10. Limits and timeouts

| `limits.` | Default | Server ceiling | When exceeded |
|---|---|---|---|
| `max_steps` (logical loop steps; transport attempts are separate, in usage and §10.2 budgets) | 8 | 32 | the last step is text-only (§10.1): `completed` + `limit_reached`, or `stopped_limit / max_steps` with the fallback answer |
| `max_tokens` (output per call) | 4096 | per provider (Anthropic 32k, MiniMax and GLM 64k — with thinking, GigaChat 8k) | `stopped_limit / max_tokens`, text kept |
| `max_tool_calls` (per run) | 16 | 64 | the batch is not executed, the next step is text-only (§10.1) |
| `max_repeated_calls` | 1 | 3 | repeats forgiven before `tool_choice: none` (§6.7); `0` — the first repeat disables tools |
| `max_presentations` | — (no limit) | — | presenting tools hidden and refused, presenting fences cut (§6.9) |
| `final_answer` (bool) | `true` | — | `false` — the pre-1.2 behavior: `max_steps` / `max_tool_calls` end the run at once, without an answer |
| `max_total_tokens` (the **full** prompt input including cache read / write, + output; all attempts) | 200 000 | 1 000 000 | `stopped_limit / max_total_tokens` — an estimated budget, checked before every attempt (§10.2) |
| `max_cost` (needs `pricing`) | — | — | `stopped_limit / max_cost` — an estimated budget, checked before every attempt (§10.2) |
| `timeout_ms` (run; waiting for a provider slot §11.6 is included) | 120 000 | 600 000 | `failed / run_timeout`, partial kept; ran out in the provider queue — `failed / provider_queue_timeout` |
| `tools[].timeout_ms` | 30 000 | 300 000 | tool error |
| `tool_result_max_bytes` | 32 768 | 262 144 | truncation with a marker |

Repair steps (§5.4) are outside `max_steps` but inside the budgets, `max_tokens` per call
and `timeout_ms`; exhausting them during repair does not fail the run — it finishes
`completed` without the block.

Ceilings live in code; a request can only tighten them. Process resources (env):
`MAX_CONCURRENT_RUNS` (32) → `429 overloaded`; `MAX_REQUEST_BYTES` (1 MB);
`TOOL_RESPONSE_MAX_BYTES` (1 MB); `SSE_BUFFER_MAX_BYTES` (2 MB per run). Parallel provider
calls — a queue per key, `PROVIDER_MAX_CONCURRENCY_*` (§11.6). Per-tenant / per-user /
daily limits belong to the harness.

### 10.1 Limits at the step boundary

A step = one model call + execution of its tool calls. The same rules for read and write:

1. **The last allowed step** (`step == max_steps`, `max_steps > 1`) is **text-only**: it
   goes with tools disabled exactly as §6.7 rule 3 does it (`tool_choice: none`; no tools
   for providers that ignore it) and with one **ephemeral** engine note at the end of the
   prompt (Appendix B): *step limit reached, tools are unavailable, answer now with what
   you have — what is done, what is not, what the user can do next*. The note is not
   stored in `messages`; the journal shows it (`step_start.content.engine_note`). The model
   gets `max_steps - 1` steps with tools: a tool call on the last step was never executed
   anyway. The model answers in text → `completed / end_turn` with
   `limit_reached: "max_steps"`; the format gate (§5.4) applies as to any final text.
   A tool call on that step is **not executed** — without a following model call nobody
   would see its result, and the effect (requesting a write operation) would be blind:
   the call gets a synthetic `tool` with `is_error: true, error: "not_executed: max_steps"`,
   `tool_calls[].status = not_executed`, run → `stopped_limit / max_steps` (rule 6 when
   there is no text). With `max_steps: 1` the single step is the run: tool calls in it are
   sealed the same way, `stopped_limit / max_steps`, no final step.
2. **A batch of tool calls larger than the remaining `max_tool_calls`** → **none** of the
   batch is executed (all-or-nothing — a partial batch of mutations is worse than none),
   the same synthetic errors with `not_executed: max_tool_calls`; the run goes on with a
   text-only step as in rule 1, the note saying *tool call limit reached, tools are
   unavailable from now on*. The same when `max_tool_calls` is used up exactly by an
   executed batch: the following step is text-only. The answer → `completed / end_turn`
   with `limit_reached: "max_tool_calls"`.
3. `max_total_tokens` / `max_cost` — per §10.2, before every attempt. Not enough → the run
   ends before the call; on the first step — `stopped_limit` with an empty answer.
4. `max_tokens` hit on a call (`finish_reason: length`) → the text is kept with
   `partial: true`; tool calls in such an answer, if any, are **not executed**, each gets
   a synthetic `tool` with `is_error: true, error: "not_executed: max_tokens"`, run →
   `stopped_limit / max_tokens`. Same reason as rule 1: the run ends here, there will be
   no next model call, and the last tool call of an answer cut by length most likely has
   truncated arguments.
5. Cancel / timeout while a batch is executing → §6.5: executed calls keep their results,
   the rest are `cancelled`.
6. **The final step produced no answer** — no text, only tool calls, a provider failure
   after retries (a model that calls a tool despite `tool_choice: none` is refused by the
   SDK; that step is not retried), or a §10.2 budget that refuses the call (no provider
   call then) → the run still ends with an answer: the engine appends an assistant message
   with a fixed text in the run locale (Appendix B), streamed as a `delta`, and the result
   carries `answer_source: "fallback"`. Status `stopped_limit`, `finish_reason` — the limit
   (`max_steps | max_tool_calls`), or the budget that refused the call
   (`max_total_tokens | max_cost`). A stream that broke after content, a timeout and a
   cancel end the run as usual (§11.3, §6.5).
7. `limits.final_answer: false` turns rules 1, 2 and 6 back to the pre-1.2 behavior: the
   tool calls of the last allowed step are sealed and the run ends
   `stopped_limit / max_steps`; a refused batch ends it `stopped_limit / max_tool_calls`;
   no answer. For callers whose continuation logic keys on `stopped_limit`.

Every boundary MUST be covered by tests (§13).

### 10.2 Budgets `max_total_tokens` / `max_cost` are estimates

The engine cannot give a strict financial guarantee: the price list comes from the
client, usage of an interrupted attempt is an estimate, a `lost` run is not reported. So
both limits are **budgets by upper estimate**, with the same rules:

1. Checked **before every provider attempt**, including transport retries, not just
   before a logical step.
2. The cost of the next attempt is estimated **in full**: input (the §5.1 estimate of the
   whole request, uncached part) + cache write (the whole `system` + `tools` if the cache
   does not exist yet) + output = `max_tokens` (worst case). With message caching
   (Anthropic, MiniMax, §9.3) the whole history counts as cache write: it is priced higher
   than plain input. For `max_total_tokens` the **whole** prompt input counts —
   `input_tokens + cache_read_tokens + cache_write_tokens` — regardless of how the
   provider bills the cache; it is a volume budget, not money.
3. An `unknown` attempt (§8.2) counts toward the budget at worst case: its estimated input
   + output = `max_tokens`, even if zero text arrived — the provider may have generated
   everything. No reconciliation within a run; the reserve is never released.
4. `spent + estimate of the next > limit` → the run ends before the call:
   `stopped_limit / max_total_tokens | max_cost`, partial kept.

## 11. Reliability

### 11.1 Graceful shutdown

On SIGTERM (a deploy):

1. `/health` → `shutting_down: true`, `POST /runs` → `503 shutting_down`.
2. In-flight runs are awaited up to `SHUTDOWN_GRACE_MS` (default 7 000: Docker sends
   SIGKILL 10 s after SIGTERM by default; measure your platform and raise it if it allows
   more).
3. Runs that did not make it are aborted like a cancel (§6.5): partial kept,
   `cancelled / shutdown`, SSE `done`, the callback — **one** attempt with a 2 s timeout.
   From this moment every callback delivery (including runs that finished earlier and are
   waiting for a retry) switches to shutdown mode: the pause between attempts is cut, one
   last attempt ≤ 2 s is made, then `failed`. A run always has exactly one delivery task;
   shutdown never starts a second one — otherwise two tasks race over one state and
   `delivered` gets overwritten with `failed`.
4. Callback deliveries and GigaChat file deletion (§5.3) are awaited up to 2 s, then the
   process exits.

The guarantee is **best-effort**: if the harness is unreachable during a deploy, the
callback will not arrive and the in-memory run will not survive the restart. The harness
learns about it at its deadline (§3). A planned deploy with a live harness loses no runs.

### 11.2 Idempotency and concurrency

- `idempotency_key` → `run_id` while the run is retained (in memory). Checked **before**
  the session lock: a repeat of the original `POST` gets `200` with the same run, not
  `409 result_pending`. Same key, different body → `409 idempotency_mismatch`. Durable
  idempotency is the harness's job, by message id.
- The lock on `meta.session_id` is held **until `ack`** (§3.1): the run is going →
  `409 session_busy` with `active_run_id` (release with `cancel`); terminal without
  `ack` → `409 result_pending` with `pending_run_id` (release with `GET` → record →
  `ack`).
- One process, one container. Scaling out = sticky routing by `run_id` **or** Redis for
  the lock and the buffer. Out of scope for v1; the API addresses everything by `run_id`
  so either option stays open.

### 11.3 Retries

- Provider: SDK `maxRetries: 0`; the engine retries itself and records every attempt in
  `usage.calls[]` (§8.1). Network / 5xx — ×2 with backoff 1 → 3 s. **429** has its own
  ladder, up to `PROVIDER_RATE_LIMIT_RETRIES` (5) retries: the pause is the provider's
  `Retry-After` (`retry-after-ms`, seconds or an HTTP date) when sent, else full jitter
  `random(0, min(PROVIDER_RATE_LIMIT_MAX_DELAY_MS, PROVIDER_RATE_LIMIT_BACKOFF_MS ·
  2^(n−1)))` — upper bounds 1 → 2 → 4 → 8 → 16 s. If the pause does not fit into the
  remaining `timeout_ms`, there is no retry: the run fails immediately with
  `failed / provider_rate_limited` instead of `run_timeout` in the middle of a sleep. A
  retry after the pause queues for the provider again (§11.6). All of this applies **only
  before the first content event** of the attempt (`delta`, `reasoning`, `tool_call`):
  after that a transparent retry is impossible — the client has already seen text, and a
  second answer would be glued to the first. An interruption after the first event → the
  run ends `failed / provider_stream_interrupted`, partial kept, the attempt is
  `unknown`, unresolved `tool_call`s get a synthetic `not_executed: stream_interrupted`.
- Tool calls are executed **only after the model attempt finished normally**
  (`finish-step`), never as they appear in the stream — an interrupted stream must not
  leave a half-executed batch. This is why the engine drives the loop step by step itself
  instead of using an SDK loop (`stopWhen` / `execute`).
- Tools: ×2 on network / 5xx, same `call_id`.
- Callback: 5 attempts (§7).
- A run as a whole is never retried — that is the harness's decision ("retry").

### 11.4 Egress

One HTTP client for tools, the callback, `openai-compatible` and images (§5.3):

- `https:` only (`ALLOW_INSECURE_EGRESS=1` allows `http://localhost` for development);
- the host must be in `EGRESS_ALLOWLIST` (env, comma-separated): an entry without a
  leading dot is an **exact** host match (`api.example.com`), with a dot it matches
  subdomains (`.example.com` matches `api.example.com` but **not** `evilexample.com`);
  built-in `base_url`s of named providers are always allowed; otherwise
  `400 egress_denied` at request validation;
- DNS resolution → the address must not be loopback / private / link-local / CGNAT
  (otherwise refused); the address is pinned for the request (DNS rebinding). An IP
  literal in a URL never reaches DNS — it is checked by the same rule before connecting,
  and an `EGRESS_ALLOWLIST` entry does not lift the ban (including IPv4-mapped IPv6 in
  hex form, which URL parsing produces from `[::ffff:127.0.0.1]`). The only exception is
  development mode `ALLOW_INSECURE_EGRESS=1` for `localhost` / `127.0.0.1` / `::1`;
- `redirect: "error"` — redirects are never followed;
- headers from the request: only `Authorization` and `X-*`, **except** `X-Forwarded-*`,
  `X-Original-*`, `X-Real-IP`, `X-HTTP-Method-Override`; `Host`, `Cookie`, hop-by-hop and
  everything else are dropped with a warning;
- connect and body timeouts, body size limits — §6.2.

**Provider proxies.** A named provider with env `<PROVIDER>_PROXY_URL` (`ANTHROPIC_`,
`OPENAI_`, `DEEPSEEK_`, `GLM_`, `GIGACHAT_`, `MINIMAX_`) goes through the proxy; others go
directly, `openai-compatible` always directly. Schemes `http:`, `https:` (CONNECT) or
`socks5:`, credentials in the URL; a malformed URL — the engine does not start. TLS to
the provider is end-to-end: the proxy sees only the host, never the key. The proxy
resolves the target address, so the private-IP check and pinning do not apply to it —
named providers have built-in `base_url`s and the proxy is set by the operator. The
allowlist and `redirect: "error"` apply as without a proxy. Proxy credentials never reach
logs; `engine_listening` logs `provider_proxies` — scheme and `host:port`. A provider
network error carries the root cause from `cause` (proxy `407`, `ECONNREFUSED`);
otherwise a proxy failure would be invisible in `provider_failure`. Typical use: regions
where a provider is not reachable directly.

### 11.5 Memory and retention

Phases of a run in memory:

1. **`running` / `cancelling`** — the full request (history, `system`, schemas, key,
   headers), the SSE buffer up to `SSE_BUFFER_MAX_BYTES`. Bounded by
   `MAX_CONCURRENT_RUNS` × `MAX_REQUEST_BYTES`.
2. **Terminal status** — `api_key`, tool headers, `system`, schemas and the original
   history are deleted immediately. The SSE buffer **collapses** into `snapshot + done`
   (kilobytes). What remains: the §7 result, the run token, the session lock until `ack`,
   the **delivery job** — `callback.url` + `callback.headers` + attempt state. Bodies of
   async tool results (`POST /runs/{id}/tool-result`) are released as soon as the loop
   consumed them or the call closed — the hash is enough for duplicate detection (§4.5).
3. **Callback delivered or attempts exhausted** — the delivery job is deleted together
   with `callback.headers`; the result for `GET` stays until retention ends.
4. **Retention expired** — the run is deleted, the lock released. The period depends on
   `acked`, not on callback delivery: `acked: true` → `RUN_RETENTION_MS`; `acked: false` →
   `RUN_RETENTION_UNACKED_MS` (event `ack_missing` on deletion).

The event journal (§12.4) lives separately from runs: its own ceiling
`LOG_BUFFER_MAX_BYTES`, deleting a run does not clear it.

Ceilings on finished runs: `MAX_RETAINED_RUNS` (env, 1000) and `MAX_RETAINED_BYTES` (env,
256 MB) — counting the serialized §7 result plus the SSE snapshot (text, `reasoning`),
which lives until the run is deleted. On overflow the oldest **`acked`** runs are evicted —
regardless of how the harness got the result (callback, `GET`, `cancel`): recovery is done,
nothing left to keep. **Non-acked runs are never evicted before their retention** — that
is part of the recovery contract (§3). If the ceiling is filled with non-acked runs only,
new `POST /runs` get `429 overloaded` until space frees up (event `retained_full`).

### 11.6 Provider queue

Providers limit concurrency per key, not per run. A launch, a batch of evals or a burst of
users on one key produce `429`s that plain retries do not fix; the §5.4 gate adds repair
steps on top.

- **Limiter key** — provider + `sha256` of the key, `base_url` and the GigaChat scope. The
  key itself never leaves the model factory; the journal and `/health` see the first 8
  hex chars of the hash.
- **Semaphore with a FIFO queue.** Every model attempt — a loop step, a transport retry, a
  §5.4 repair step — needs a slot and holds it until the stream ends. A free slot with
  nobody waiting is granted immediately: a lone run notices nothing; otherwise the attempt
  joins the tail of the queue. A retry after a 429 joins the tail again.
- **Waiting happens inside the run's `timeout_ms`** and no longer than
  `PROVIDER_QUEUE_TIMEOUT_MS` (60 s). Missing either deadline →
  `failed / provider_queue_timeout`, `retriable: true`; no attempt in `usage.calls` — the
  provider never saw the request. `cancel` / shutdown while queued is an ordinary
  `cancelled`. In a §5.4 repair step a queue timeout is the gate's
  `reason: provider_failure`, and the run is `completed`.
- **The ceiling is AIMD.** Start and maximum — `PROVIDER_MAX_CONCURRENCY_<PROVIDER>`
  (GigaChat 6 — below its real limit, with a margin for other users of the key; GLM 4;
  the rest — `PROVIDER_MAX_CONCURRENCY_DEFAULT`, 16). A 429 → the ceiling ×0.5 (not below
  1) and a pause in granting new slots `PROVIDER_THROTTLE_COOLDOWN_MS` (1 s; a longer
  `Retry-After` wins, capped by `PROVIDER_RATE_LIMIT_MAX_DELAY_MS`). A 429 on a slot
  granted **before** the last decrease does not touch the ceiling: a burst of N
  simultaneous refusals is one decrease, not N. `PROVIDER_THROTTLE_INCREASE_AFTER` (10)
  successful attempts in a row → +1, up to the env value. Network errors, 5xx and aborts
  do not touch the ceiling. Growth does not wait for saturation: in quiet periods the
  ceiling returns to the env value, and the next burst probes the limit again at the cost
  of a couple of retried 429s.
- Idle keys at the default ceiling are not kept; a lowered one is kept until it recovers.
- **One process** (§11.2): state is in memory, a restart resets the ceiling to env.
  Several instances would share a key's limit blindly — the ceiling is per instance.
- `PROVIDER_THROTTLE=0` — no queue and no AIMD; §11.3 retries on 429 remain.

Reference measurement (GigaChat-2-Pro, `max_steps: 1`, ≈ 200-word answers, 4–5 s streams;
N parallel `wait: true` runs on one key):

| | 16 runs | 20 runs |
|---|---|---|
| no queue, retries 1 → 3 s | 18 × 429, **6 `failed`** | 30 × 429, **10 `failed`** |
| no queue, 429 retries per §11.3 | 23 × 429, 0 `failed`, 14.4 s | 38 × 429, 0 `failed`, 14.6 s |
| queue, ceiling 6 (default) | 0 × 429, 0 `failed`, 14.6 s | 0 × 429, 0 `failed`, 18.0 s |
| queue, ceiling 16 — AIMD finds the limit | — | 6 × 429, 0 `failed`, 13.9 s; ceiling 16 → 8 → 10 |

## 12. Errors and observability

### 12.1 Codes

| code | HTTP / status | retriable |
|---|---|---|
| `bad_request`, `unresolved_tool_call`, `write_context_missing`, `egress_denied`, `unauthorized` | 400 / 401 | no |
| `history_ends_with_assistant` — the history ends with `assistant` (§5) | 400 | no |
| `provider_not_allowed`, `provider_key_missing` | 400 | no |
| `unsupported_media_type`, `image_too_large` | 400 | no |
| `session_busy`, `result_pending` | 409 | yes (after cancel / after `GET` → `ack`) |
| `idempotency_mismatch`, `result_mismatch`, `not_finished` | 409 | no |
| `payload_too_large` | 413 | no |
| `overloaded`, `shutting_down` | 429 / 503 | yes |
| `run_not_found`, `call_not_found`, `call_closed` | 404 / 409 | no |
| `image_fetch_failed` | failed | yes |
| `provider_stream_interrupted` | failed | yes (with a new run, partial kept) |
| `provider_auth` | failed | no |
| `provider_rate_limited`, `provider_unavailable` | failed | yes |
| `provider_queue_timeout` — no provider slot in time (§11.6) | failed | yes |
| `provider_error` (provider 4xx) | failed | no |
| `context_too_large` | failed | no |
| `run_timeout` | failed | yes |

A provider error carries `provider_status` and a scrubbed `provider_body` — "the OAuth
token expired" and "the model does not exist" are distinguishable without reading logs.

### 12.2 Logs

JSON (pino) to stdout, one line per event, each with `run_id`; where available —
`session_id`, `step`, `call_id`, `provider`, `model`, `duration_ms`, tokens. The event
catalog is §12.4; stdout is filtered by `LOG_LEVEL`, the journal records every level.
**Message contents, prompts, tool args / results and keys never go to stdout**
(`LOG_PROMPTS=1` — local development only): event content goes only to the in-memory
journal (§12.4), keys go nowhere. In every URL that reaches a log (access log,
`callback_sent`, `egress_headers_dropped`) the values of **all** query parameters are
replaced with `<redacted>`: that is where engine run tokens and third-party secrets live.
Parameter names stay.

Implementation rule: every loop decision (a limit, a refusal, a retry, a detector) is a
named event in the §12.4 catalog; metadata goes to stdout and the journal, content only to
the journal.

### 12.3 Error webhook

Container logs are often read by nobody in real time, and some failures the harness
cannot see itself: an undelivered callback is exactly the case where nothing reached it.
If env `ERROR_WEBHOOK_URL` is set, the engine POSTs JSON to it:

```json
{ "contract_version": "1", "event": "callback_failed", "at": "2026-09-21T08:40:00.000Z",
  "engine_version": "1.0.0", "run_id": "run_…", "session_id": "…", "meta": { … },
  "status": "completed", "finish_reason": "end_turn",
  "callback": { "url": "https://…/cb?token=%3Credacted%3E", "attempts": 5, "last_error": "HTTP 403" } }
```

| `event` | When | Fields beyond the common ones |
|---|---|---|
| `callback_failed` | all callback attempts exhausted (§7) | `status`, `finish_reason`, `callback { url, attempts, last_error }` |
| `run_failed` | a run finished `failed` | `status`, `finish_reason`, `error { code, message, retriable, provider_status }`, `provider`, `model` |
| `ack_missing` | a terminal run was deleted without `ack` (§3.1) — the session lock hung for the whole retention | `status`, `reason` |
| `run_crashed` | an exception in the loop bypassed normal handling | `error { message }` |
| `unhandled_error` | an unhandled exception in the HTTP layer (`500 internal_error`) | `path`, `error { message }` |

- **Best-effort:** one attempt, 5 s timeout, no retries; a webhook failure does not affect
  the run and is only logged (`error_webhook_failed`). It is a signal, not a journal — the
  source of truth stays `GET /runs/{id}` and the logs.
- Goes through the egress client (§11.4): HTTPS, host in `EGRESS_ALLOWLIST`. Signed with
  the same `X-Engine-Secret` from `CALLBACK_SECRET` as the callback (§7).
- At most 30 events per minute per process, the rest are dropped
  (`error_webhook_rate_limited` with the drop count): an error storm must not become a
  request storm.
- §12.2 rules apply: no message contents, prompts, tool args / results or keys in the
  body; `error.provider_body` is not sent (it may quote the prompt); the query of
  `callback.url` is scrubbed.
- `POST /runs` refusals (`4xx`) are **not** sent — the caller receives them anyway.

### 12.4 Event journal

Every log event is also written to a ring buffer in process memory, and with `LOG_DIR` to
day files on disk; both are read by `GET /logs` and `GET /runs/{id}/logs` (§4.9). Purpose:
to understand why an agent looped or answered wrongly you need a run timeline with content,
and you need it without shipping prompts to a log pipeline. There is no database (§2):
without `LOG_DIR` a restart or deploy means an empty journal.

- **Ceilings:** `LOG_BUFFER_MAX_ENTRIES` (20 000) and `LOG_BUFFER_MAX_BYTES` (32 MB); on
  overflow old entries are evicted in a batch down to 90 % of the ceiling (counter
  `buffer.dropped`). `LOG_BUFFER_MAX_ENTRIES=0` disables the journal.
- **Content** — the event's `content` field: prompt, history tail, model texts,
  reasoning, tool args / results, tool response body on 4xx / 5xx, provider error body.
  Recorded by default (`LOG_BUFFER_CONTENT=0` — metadata only). Every field is cut to
  `LOG_CONTENT_MAX_CHARS` (4000) with a `…[+N chars]` note; `sk-…` / `Bearer …` /
  `"api_key": "…"` are scrubbed. Access is the same `ENGINE_TOKEN` with which
  `GET /runs/{id}` already returns full `messages` — the circle of access is no wider.
- **Never in the journal:** `llm.api_key`, env keys, values of tool and callback headers,
  `CALLBACK_SECRET`, run and call tokens; the query of every URL is scrubbed (§12.2).
- **Prompts by hash.** `run_start` carries `content.system_sha256` (hex SHA-256 of the
  scrubbed text) instead of `system`; the text is stored once — in memory as a blob shared
  by the entries that reference it, on disk as a `prompt_blob` line (`sha256`,
  `content.text`) written the first time the hash appears in a day file in this process.
  `GET /logs` fills `system` back by default (§4.9).
- `session_id` is added to every event of a run by `run_id`, so a session filter sees the
  whole run, not just `run_start`.
- **Disk journal** (`LOG_DIR`, off by default). Every entry is appended to
  `LOG_DIR/journal-YYYY-MM-DD.jsonl` (UTC date of the entry), one JSON object per line —
  the `GET /logs` entry shape plus `boot_id`. Writes are buffered and flushed every second,
  on shutdown and on process exit: a deploy loses at most the last second. Content on disk
  is cut to `LOG_DISK_CONTENT_MAX_CHARS` (200 000), a safety net rather than a trim;
  `LOG_CONTENT_MAX_CHARS` applies to memory and stdout only. Scrubbing is identical;
  `LOG_BUFFER_CONTENT=0` turns content off on disk too. Files are `0600`, the directory
  `0700`. Retention: on startup and hourly, day files older than `LOG_RETENTION_DAYS` (7;
  `0` — today only) are deleted; over `LOG_DIR_MAX_BYTES` (2 GB) the oldest whole days go
  first. The current day file is never deleted. The disk journal needs a persistent
  volume: on the container's root filesystem it lives as long as the container
  (`journal_disk_ephemeral` at startup). One writer per directory (§11.2): several
  instances on one volume need their own subdirectories.
- The access log (`http_request`) does not go to the journal — otherwise reading the
  journal would spam it.

| Event | Level | When | Content |
|---|---|---|---|
| `run_rejected` | warn | `POST /runs` refused (§4.2): `http_status`, `code`, `message`, `details`, `session_id`, `model` | — |
| `run_replayed` | info | a repeat by `idempotency_key` returned an existing run | — |
| `locale_unsupported` | warn | `meta.locale` is not a supported locale (Appendix B): `requested`, `locale` — the one the run uses | — |
| `llm_param_unsupported` | warn | an `llm.params` entry is not supported by the provider or model and was not sent (§9.3): `param`, `provider`, `model` | — |
| `run_start` | info | start: model, tools as `name:effect`, limits, window, cache, history by role, `meta`, callback | `system_sha256` (`system` when read back, §4.9), `history_tail` (the last 6 messages as a string) |
| `step_start` | debug | before a step: messages in the prompt, token estimate, `tools_disabled`, `tool_calls_used`, `final_answer_step: true` on the text-only final step (§10.1), `presentations_used` with `max_presentations`, `tools_visible` without hidden presenting tools | `engine_note` on the final step |
| `context_trimmed` | warn | context trimmed (§5.1): messages before / after, estimate, window | — |
| `thinking_blocks_dropped` | info | the provider dropped stale thinking blocks after an engine-made prefix edit (§9.3): `step`, `dropped`, `reasons` | — |
| `provider_attempt` | info | every provider attempt (§8): status, `finish_reason`, tokens, `provider_request_id` | — |
| `provider_failure` | warn | an attempt failed: `kind`, `code`, `message`, `provider_status`, `retry_in_ms`, `retry_after_ms` (the provider's `Retry-After`), `retry_skipped` — `retries_exhausted \| run_deadline`; for 429 — `rate_limit_retry` (429 retries so far) | `provider_body`, `partial_text` |
| `provider_queue_wait` | info / warn | an attempt waited in the provider queue (§11.6): `outcome` — `granted \| timeout \| aborted`, `wait_ms`, `queue_depth`, `limit`, `active`, `queue_timeout_ms`, `throttle_key`; no event for an immediate slot | — |
| `provider_throttle` | warn / info | AIMD changed a key's ceiling (§11.6): `direction` — `down` (429: `limit_from` → `limit_to`, `cooldown_ms`, `retry_after_ms`, `run_id` of the run) or `up` (a success streak); `provider`, `throttle_key`, `max`, `active`, `queued` | — |
| `step_done` | info | a step finished: `finish_reason`, tokens, tool call names | `text`, `reasoning`, `tool_calls` with args |
| `limit_hit` | warn | a §10 limit / §10.2 budget: `limit` and numbers (`step`, `used`, `requested`, `spent_tokens`, …); `final_answer: true` — the run goes on to the text-only step (§10.1) | — |
| `final_answer` | info / warn | the text-only final step decided (§10.1): `limit`, `outcome` — `model \| fallback`; `reason` for `fallback` — `empty_text \| tool_calls_ignored_none \| provider_error \| budget` | — |
| `tool_call` | info | a call went to its endpoint: `effect`, `endpoint` (query scrubbed), `timeout_ms` | `args` |
| `tool_http` | debug / warn | every HTTP attempt of a tool: `attempt`, `http_status` or `error`, `retry` | `body` on 4xx / 5xx |
| `tool_accepted` | info | a tool answered `accepted`, waiting for `result_url` | — |
| `tool_result_received` | info / warn | `POST /runs/{id}/tool-result`: accepted, duplicate, refused | `result` / `error` |
| `tool_result` | info | call outcome: `outcome`, `status`, `error`, `truncated`, `empty`, `operation_id` | `result` |
| `tool_call_repeated` | warn | a repeat of a previous step's call (§6.7) | `args` |
| `tool_call_rejected` | warn | invalid args / unknown tool (§6.1); `reason: tool_not_loaded` — a hidden deferred tool (§6.8) | `args` |
| `skills_restored` | info | before step 1, when the history loaded skills (§6.8): `skills`, `tools` | — |
| `builtin_history_invalid` | warn | a `builtin: true` message of the wrong shape, treated as ordinary history: `call_id`, `tool` | — |
| `skill_loaded` | info | `load_skill` ok: `name`, `step`, `tools` (activated), `reloaded` | — |
| `skill_unknown` | warn | `load_skill` with an unknown name | `name` (model text) |
| `tool_search` | info | `search_tools` executed: `step`, `limit`, `tools`, `in_skills` | `query` (model text) |
| `duplicate_write_intent` | warn | two calls of one write tool in a step (§6.3) | `args` |
| `tools_disabled` | warn | `tool_choice: none` from now on (§6.7): `reason`, repeat and empty counters, `max_repeated_calls` | — |
| `presentation` | info | a presentation counted (§6.9): `kind`, `name`, `call_id`, `used`, `max` | — |
| `presentation_limit` | warn | a presenting call refused or a fence cut (§6.9): `kind`, `name`, `call_id`, `step` | `args` / `block` |
| `interim_block_dropped` | warn | `interim: "drop"` removed blocks from a tool step (§5.4): `fence`, `step`, `blocks` | `text` (the original step text) |
| `output_check` | debug / info / warn | a format gate decision (§5.4): `fence`, `attempt` (0 — the original answer), `outcome` — `absent \| passed \| invalid \| ungrounded` for 0, `repaired \| invalid \| ungrounded \| missing` for repairs, `failed` + `reason` — gave up; `errors` — paths. `step_start`, `provider_attempt`, `provider_failure`, `limit_hit` of a repair step carry `repair: <fence>`, `repair_attempt` | `issues` (error lines), `block` (original block), `draft` (repair answer) |
| `tool_protocol_error` | error / warn | a write tool answered anything but `deferred`, or `deferred` without `operation_id` | `body` |
| `tool_calls_sealed` | info | unresolved tool calls got a synthetic error (§6.5, §10.1) | — |
| `run_timeout` | warn | `limits.timeout_ms` fired | — |
| `run_done` | info / error | terminal: status, reason, steps, tools, tokens, cost, error, `context_tokens`, `context_window` (`result.context`, §7), `limit_reached`, `answer_source` | `answer`, `provider_body` |
| `gigachat_files_deleted` | info / warn | end of a run that uploaded images to GigaChat (§5.3): `files`, `failed`, `errors` for undeleted ones | — |
| `run_failed`, `run_crashed`, `unhandled_error` | error | an exception bypassed normal handling, with `stack` | — |
| `callback_attempt_failed` | warn | a callback attempt failed: `error`, `next_in_ms`, `shutdown` (an attempt in shutdown mode, §11.1) | — |
| `callback_sent`, `callback_failed` | info / error | delivery outcome (§7) | — |
| `ack` | info | session lock released: `via` — `callback` / `endpoint` / `wait` | — |
| `cancel`, `sse_subscribe`, `run_deleted`, `ack_missing` | info / debug / warn | stop, SSE subscription, run deletion (`retention` / `evicted`) | — |
| `egress_denied`, `egress_headers_dropped`, `retained_full`, `shutdown`, `engine_listening` | warn / info | egress refusals and dropped headers, retention full, shutdown, startup (`provider_proxies`, `locale`, `default_timezone`) | — |
| `journal_retention` | info | day files deleted by age on startup or the hourly tick: `deleted` | — |
| `journal_pruned` | warn | `LOG_DIR_MAX_BYTES` exceeded, oldest days deleted: `deleted`, `bytes_before`, `bytes_after` | — |
| `journal_disk_ephemeral` | warn | startup: `LOG_DIR` is on the root filesystem (same device as `/`) — a hint, not an error | — |
| `journal_write_failed` | warn | stdout only: appending to a day file failed, `err` | — |

## 13. Conformance tests

`vitest`, no network, no keys. An implementation is conformant when it passes the
equivalent of the following suites.

1. **Unit:** `StoredMessage ↔ ModelMessage` (tool pairs, `reasoning` with
   `provider_metadata`); context estimation and trimming; usage aggregation and cache-token
   normalization per provider; `unknown` attempts; `cost`; tool result truncation; egress
   validation (exact host vs `.suffix`, private IPs, headers and `X-*` exceptions); §10.2
   budgets with `unknown` worst case; GigaChat images (user parts → `attachments` one per
   message, upload to `/files` once per run, an upload refusal as the attempt's answer,
   deletion at the end of the run and waiting for it on shutdown, MIME per provider);
   MiniMax through the real Anthropic adapter (URL, key, `adaptive`, signed thinking →
   history → next step unchanged, MiniMax and Anthropic signatures never mixed); tool
   ordering by name; date lines from `created_at` and the current-time anchor.
2. **Loop on `MockLanguageModelV3`** (AI SDK): text without tools; one tool call; parallel
   calls (result order = call order); a tool error → the model continues; `accepted` +
   `tool-result` (first, duplicate with the same body, `result_mismatch`, `call_closed`
   after the call timeout and after the terminal status); `deferred` with `operation_id`;
   stream interrupted before the first event → retry, after the first `delta` →
   `provider_stream_interrupted` without retry, tool calls not executed; tools start only
   after `finish-step`; two calls of one write tool in a step → `duplicate_write_intent`,
   read tools of the same batch execute; a write tool answered sync → `protocol_error`; an
   empty result → marker for the model, `null` in history; a repeated call →
   `repeated_call` without hitting the endpoint, a second repeat and a second empty result
   of one tool → `tool_choice: none` and `completed`; every §10.1 boundary, the text-only
   final step (note, `limit_reached`, every fallback reason, `final_answer: false`); cancel
   mid-stream (partial + synthetic tool errors + `unknown`); run timeout; provider retries
   with attempt records.
3. **HTTP end-to-end** in-process (Hono `app.request` + fake tool server + fake callback):
   `POST /runs` → SSE → callback; `wait: true`; `idempotency_key` (same / mismatch); a write
   tool without `idempotency_key` / `meta.session_id` / `history_revision` →
   `400 write_context_missing` listing fields, read-only passes without them;
   `session_busy` → `cancel` → new run; `Last-Event-ID` replay and `gap`; `expose_*`;
   `snapshot` on connect without `Last-Event-ID` and after `gap`; `404` after retention;
   `GET` with `callback.status` after a failed delivery; eviction by `MAX_RETAINED_RUNS`;
   no `api_key` / history in memory of a terminal run; `data:` and https images through
   egress; shutdown with an in-flight run; `413`; `egress_denied`; `cancel` →
   `202 cancelling` with a hanging tool and a repeated `cancel`; lock until `ack`:
   `result_pending` → `GET` → `ack` → `POST` passes, implicit ack on a 2xx callback and on
   `wait: true`; `snapshot.through_event_id` — tail without duplicates; no
   `callback.headers` in memory after delivery, present before it; implicit ack only for
   `wait: true` without `session_id`, with `session_id` the lock holds until an explicit
   `ack`; a repeated `POST` with the same `idempotency_key` → `200`, not
   `409 result_pending`; `history_revision` echoed in the callback and `GET`; `seq`
   monotonic within a run; only `acked` runs evicted, `MAX_RETAINED_BYTES` and `429` with
   non-acked runs only.
4. **Skills** (§6.8): the index in `system`, sorted, `en` / `ru`; `load_skill` returns
   header and body, the skill's tools are callable from the next step only, and
   `max_tool_calls` is untouched; `tool_not_loaded`, not a repeat; unknown skill; the same
   skill twice is `repeated_call`; restoration from history and a reload; an unmarked or
   malformed pair activates nothing; on `tool_reference` every step carries every tool with
   `deferLoading`, `cache_control` on the last non-deferred, a `tool_result` of references only with the text after it, tools on
   `none` steps; trimming keeps the activating turn; without the feature an HTTP tool named
   `load_skill` is ordinary, with it the name is a `400`; the other `400`s of §4.2.
   `search_tools`: BM25 (camelCase split, argument names, positive scores only, ties by
   name, `limit`, the 500-character cut); matches outside skills activate from the next
   step, `in_skills` do not; the no-match text; found tools restored from history.
5. **Format gate** (§5.4): block search (last block, inline fence, unclosed,
   `<|superquote|>`); schema parity with the client on a corpus of real model outputs;
   model-facing errors (unknown keys, `oneOf` branches, ≤ 8 lines); `passed` without extra
   steps, `repaired` with the final text, `failed` after `max_repairs`, `absent`; a step
   with a tool call is not checked; `tool_choice: none` on repair; `400` on an invalid
   schema; budget, timeout and cancel during repair; SSE order; `output_checks` in the
   callback, `GET` and journal.
6. **Provider queue** (§11.3, §11.6): concurrency never above the ceiling, FIFO, timeout
   and abort while queued, different keys — different queues; AIMD — a 429 halves the
   ceiling and sets a pause, a burst from old slots decreases once, a success streak
   restores the ceiling, `Retry-After` stretches the pause up to its cap; `Retry-After`
   parsing (seconds, `-ms`, HTTP date) and full jitter within bounds; in the loop — a lone
   run never queues, the ceiling holds with 12 parallel runs, `provider_queue_timeout` by
   env and by `timeout_ms`, cancel while queued, 429 retry by `Retry-After` and with
   jitter, retry limit, a pause that does not fit `timeout_ms`, a retry queues again, a 429
   after content is not retried, `/health`; the limiter key never contains the key.
5a. **Presentations** (§5.4, §6.7, §6.9): admission order within a step, hiding and
   refusal once spent (a repeat of a refused call counts), errors do not spend, a fence
   cut as `suppressed`, a skill-activated presenting tool stays hidden, no limit — no
   effect; `interim: "drop"` (stored message, next prompt, SSE, unclosed block, only a
   block), `keep`; `max_repeated_calls` `0` and clamping; `grounded` — history and run
   results, numbers as strings, `*` over arrays and keys, repair with `ungrounded`,
   `failed`, a path matching nothing.
6a. **Journal** (§4.9, §12.4): filters, content off, scrubbing; prompts by hash (one
   `prompt_blob` per day file, `system` read back, `inline_prompts=false`); the disk
   journal — day files, `0600`, flush on shutdown, reads after a restart (`source: disk`)
   and past the memory ceiling (`mixed`, a tail with `since`), `days`, retention by age and
   by size, today kept.
7. **Live smoke** (`npm run smoke`, keys in `.env`, not in CI): Anthropic with a tool call
   and thinking; GigaChat OAuth + TLS; an image with a code in it at Anthropic, OpenAI,
   GigaChat and MiniMax-M3 — the model must read the code; MiniMax M2.7 and M3 with a tool —
   the signed thinking block goes back on the second step.

## 14. Deployment and configuration

Docker (`node:22-slim`, Russian Trusted Root CA in the image for GigaChat), `EXPOSE 8080`,
a single always-on container. What the engine expects from the platform and what it means:

- **Health check path = `/health`**: it answers 2xx as soon as the server listens, without
  probing providers — otherwise a deploy would fail while a provider is down.
- **The switch-over window.** On platforms that start a new container, wait for its health
  check and then switch traffic at once, runs of the old container become unreachable for
  `stream` / `cancel` / `GET` / `ack` after the switch — the new container answers `404`.
  Hence: the old container handles SIGTERM per §11.1 (abort + callback
  `cancelled / shutdown`), and the harness **MUST accept a late callback for a run already
  marked `lost`** (§3). An end-user client that gets `404` on `stream` shows "the answer
  was interrupted by an update, please retry".
- Deploy in low-traffic windows; `/health` reports `active_runs` to pick the moment.
- `SHUTDOWN_GRACE_MS` defaults to **7 000** — below Docker's 10 s before SIGKILL. Measure
  your platform (time from traffic switch to SIGTERM, from SIGTERM to SIGKILL) and set it
  accordingly.
- Several instances (Redis / sticky routing) — out of scope for v1; one container.

```
PORT=8080
PUBLIC_URL=https://loop.example.com        # base for stream_url / cancel_url / result_url
ENGINE_TOKEN=…                             # required; several — comma-separated
ALLOWED_ORIGINS=https://app.example.com    # CORS for end-user clients
EGRESS_ALLOWLIST=api.example.com           # hosts of tools / callback / base_url (.suffix allowed)
ALLOW_INSECURE_EGRESS=0                    # 1 — http://localhost for development
ENGINE_LOCALE=en                           # en | ru — engine-injected text, Appendix B
DEFAULT_TIMEZONE=UTC                       # when meta.timezone is absent, §9.4
MAX_CONCURRENT_RUNS=32
MAX_REQUEST_BYTES=1048576
TOOL_RESPONSE_MAX_BYTES=1048576
SSE_BUFFER_MAX_BYTES=2097152
RUN_RETENTION_MS=600000
RUN_RETENTION_UNACKED_MS=3600000
MAX_RETAINED_RUNS=1000
MAX_RETAINED_BYTES=268435456
CALLBACK_ATTEMPT_TIMEOUT_MS=10000
CALLBACK_SECRET=                           # callback signature: header X-Engine-Secret (§7)
ERROR_WEBHOOK_URL=                         # engine error webhook (§12.3); host must be in EGRESS_ALLOWLIST
IMAGE_MAX_BYTES=5242880
SHUTDOWN_GRACE_MS=7000
MAX_CONTEXT_FALLBACK=128000
PROVIDER_THROTTLE=1                        # provider queue and AIMD (§11.6); 0 — off
PROVIDER_MAX_CONCURRENCY_DEFAULT=16        # ceiling of parallel calls per provider key
PROVIDER_MAX_CONCURRENCY_GIGACHAT=6        # likewise _ANTHROPIC / _OPENAI / _DEEPSEEK / _MINIMAX / _OPENAI_COMPATIBLE
PROVIDER_MAX_CONCURRENCY_GLM=4
PROVIDER_QUEUE_TIMEOUT_MS=60000            # max wait for a slot; cut by the remaining timeout_ms
PROVIDER_THROTTLE_COOLDOWN_MS=1000         # pause in granting slots after a 429
PROVIDER_THROTTLE_INCREASE_AFTER=10        # successes in a row for +1 to the ceiling
PROVIDER_RATE_LIMIT_RETRIES=5              # retries on 429 (§11.3)
PROVIDER_RATE_LIMIT_BACKOFF_MS=1000        # full-jitter base without Retry-After
PROVIDER_RATE_LIMIT_MAX_DELAY_MS=16000     # cap of backoff and of the pause after a 429
LOG_LEVEL=info                             # stdout only; the journal records every level
LOG_PROMPTS=0                              # 1 — event content in stdout too (local only)
LOG_BUFFER_MAX_ENTRIES=20000               # event journal for GET /logs (§12.4); 0 — off
LOG_BUFFER_MAX_BYTES=33554432              # 32 MB
LOG_BUFFER_CONTENT=1                       # 0 — metadata only in the journal
LOG_CONTENT_MAX_CHARS=4000                 # cap of one content field, memory and stdout
LOG_DIR=                                   # disk journal (§12.4): day files here; unset — off. Needs a persistent volume
LOG_RETENTION_DAYS=7                       # day files older than this are deleted; 0 — today only
LOG_DIR_MAX_BYTES=2147483648               # 2 GB; over it the oldest days are deleted first
LOG_DISK_CONTENT_MAX_CHARS=200000          # cap of one content field on disk
ANTHROPIC_API_KEY= OPENAI_API_KEY= DEEPSEEK_API_KEY= GLM_API_KEY= MINIMAX_API_KEY=
ANTHROPIC_PROXY_URL= OPENAI_PROXY_URL=     # provider proxy (§11.4); likewise DEEPSEEK_ / GLM_ / GIGACHAT_ / MINIMAX_
GIGACHAT_AUTH_KEY= GIGACHAT_SCOPE=GIGACHAT_API_PERS
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt   # set in the Dockerfile
```

Code layout of the reference implementation:

```
src/
  index.ts              Hono routes, CORS, auth, body limit, SIGTERM
  config.ts             env
  contracts.ts          zod: RunRequest, StoredMessage, ToolResponse, RunResult
  runs/registry.ts      in-memory runs: status, SSE buffer, run / call tokens, session lock, idempotency
  runs/runner.ts        the loop, STEP BY STEP: streamText for one step → finish-step → collect
                        tool calls → §10.1 limits → execute → next step; AbortController
  runs/usage.ts         attempts ok / failed / unknown, per-provider normalization, estimated, cost
  runs/messages.ts      StoredMessage ↔ ModelMessage (+ reasoning), context estimate and trimming, dates
  runs/output-checks.ts the §5.4 gate
  runs/callback.ts      result delivery with retries, delivery status
  tools/http.ts         endpoint calls: ok / error / accepted / deferred, effect control, retries
  egress/client.ts      the single fetch: allowlist, private IPs, no redirects, headers, size caps
  stream/sse.ts         SSE with buffer, Last-Event-ID replay, gap, ping
  providers/            allowlist (kind, base_url, caps, window), factory, GigaChat OAuth and
                        translator, throttle — queue and AIMD ceiling per key (§11.6)
  log.ts, log-buffer.ts structured events, the in-memory journal
```

## 15. Out of scope for v1

Several instances (Redis); step-level durable execution; history summarization; approval
logic in the engine (it lives in the harness through `deferred`); scoped tokens for several
server-side clients; RAG / embeddings; multi-agent orchestration; structured / card
answers as a content type (room is left: a new `type` in `ContentPart` does not break old
clients); per-tenant quotas (harness). Candidates for later versions are discussed in
[ROADMAP.md](ROADMAP.md).

## Appendix A. Harness obligations

A harness is conformant when it does all of the following. Most failures in production
come from skipping one of these.

| # | Obligation | Section |
|---|---|---|
| H1 | Send the **full** history in every run; the last message is `user` or `tool`. | §5 |
| H2 | Set `created_at` on every user message, so the history between turns is only appended to (cache, signed thinking). | §5, §9.4 |
| H3 | With any write tool: send `idempotency_key` (the user message id), `meta.session_id`, `history_revision`. | §4.2 |
| H4 | Write results **idempotently**: run by `run_id`, messages by `<run_id>:<seq>`, tool results by `call_id`. | §3.1 |
| H5 | Answer the callback with 2xx **only after** a durable write of everything (that is the ack). Otherwise answer non-2xx — the engine retries. | §3.1, §7 |
| H6 | Deduplicate callbacks by `payload.run_id`; verify `X-Engine-Secret` if configured. | §7 |
| H7 | When the result came via `GET` or `cancel`, send `POST /runs/{id}/ack` after writing it. | §4.8 |
| H8 | At the deadline (`timeout_ms + 120 s` without a callback) call `GET /runs/{id}` before declaring the run lost; only `404` is `lost`. | §3 |
| H9 | Accept a late callback for a `lost` run; place it by `history_revision` (equal → insert, different → audit + `event` part). | §3 |
| H10 | Never start a run for a session while the previous result is not recorded and acknowledged; on `409 result_pending` fetch → record → ack → retry. | §3.1 |
| H11 | Interrupt = `cancel` (synchronous) → record → ack → new run. There is no preempt. | §6.5 |
| H12 | A user message during `awaiting_tool`: close every pending `call_id` with a synthetic `superseded` tool error; never reuse that `call_id`; deliver the late operation result as an `event` part. | §3.1 |
| H13 | Continue `awaiting_tool` only when **every** deferred `call_id` has a result, all `tool` messages first. | §3.1 |
| H14 | Write endpoints only register an intent and **always** answer `deferred` with a durable `operation_id`, following the lookup order (origin → pending comparison → create) with `opref` references. | §6.4 |
| H15 | Execute mutations only after approval, with `operation_version` checked and `operation_id` passed downstream as the idempotency key. | §6.4 |
| H16 | Scope tool data by `meta` (`tenant_id`, `user_id`), never by ids from `args` — the model can put any id there. | §6.1 |
| H17 | Keep tool results compact; the engine truncates at `tool_result_max_bytes`. | §6.2 |
| H18 | Hand `stream_url` / `cancel_url` to end-user clients as is; never expose `ENGINE_TOKEN`. | §4.1 |
| H19 | Reconcile `Σ usage.total` with provider billing periodically. | §8.4 |
| H20 | Store the `tool` messages of `load_skill` and `search_tools` verbatim, `result` and `builtin` included: the engine restores loaded skills from them on the next run, and only marked messages count. | §5, §6.8 |
| H21 | A run that ends other than `awaiting_tool` with a `tool_calls[]` entry carrying `operation_id` and `status: "cancelled"`: cancel that operation, so its approval can no longer execute; the history already closes the call. | §6.5 |
| H22 | Render the last assistant message of a `stopped_limit` run when it has text — with the final step on it is always there (the model's answer or the `answer_source: "fallback"` text); an error screen is for an empty answer only. | §7, §10.1 |

A reference harness, a conformance test kit for harnesses and examples for common platforms
are on the roadmap.

## Appendix B. Engine-injected text and locale

Some text is produced by the engine itself: lines it injects into the prompt and the
`error.message` of a failed run. All of it follows the run locale: `meta.locale`, else env
`ENGINE_LOCALE`, else `en`. Supported: `en`, `ru`. An unsupported `meta.locale` falls back
to the engine locale with a `locale_unsupported` warning, and the run proceeds; an invalid
`ENGINE_LOCALE` stops the engine at startup. Machine fields (`code`, `status`,
`finish_reason`, event names, `errors` paths) and the `[engine]` prefix never depend on the
locale. `POST /runs` refusals (4xx), startup configuration errors and log text are always
English — they are read by developers, not by the model or the end user. Text coming from
providers, the network and tools is passed through as received.

| Where | `en` |
|---|---|
| Message date (§9.4) | `[engine] Message date and time: <ISO with offset> (<timezone>).` |
| Current time (§9.4) | `[engine] Current date and time: <ISO with offset> (<timezone>).` |
| Empty tool result (§6.2) | `[engine] The tool succeeded and returned an empty result — there is no data. Calling it again with the same arguments will return the same.` |
| Repeated call (§6.7) | `repeated_call: this exact call was already executed in this run; its result is above. Repeating it returns the same — use the result you have or answer the user.` |
| Final step note (§10.1) | `[engine] Step limit reached: tools are unavailable on this step.` or `[engine] Tool call limit reached: tools are unavailable from now on.`, then `Answer the user now with what you already have: what is done, what is not, and what the user can do next. Do not promise to call tools.` |
| Presentation limit (§6.9) | `presentation_limit: <tool> was not called — the user already sees a result of this run. Answer in text about what is shown.` |
| Ungrounded value (§5.4) | `"<value>" is not among the values returned by <tool>, <tool>` |
| Final step fallback answer (§10.1) | `I ran out of steps before finishing. Please send the request again, or narrow it down.` |
| Invalid tool input (§6.1) | `invalid_tool_input: <reason>`, e.g. `arguments: missing required field "id"`, `n: expected integer, got string` |
| Skill index header (§6.8) | `[engine] Skills. Before working on a topic a skill covers, call load_skill with its name: the instructions, and the tools the skill unlocks, arrive on the next step.` |
| `load_skill` description (§6.8) | `Load a skill listed in the system prompt: returns its instructions and makes its tools available from the next step.`; argument `name`: `Skill name, exactly as listed.` |
| Skill loaded (§6.8) | `[engine] Skill "<name>" loaded. Tools available from the next step: <a>, <b>.` or `[engine] Skill "<name>" loaded.` |
| Unknown skill (§6.8) | `unknown_skill: <name>. Available skills: <a>, <b>.` |
| Tool not loaded (§6.8) | `tool_not_loaded: <tool> belongs to skill "<skill>". Call load_skill("<skill>") first.` or `tool_not_loaded: <tool> is not loaded. Find it with search_tools first.` |
| `search_tools` description (§6.8) | `Find tools that are not loaded yet, by what they do. Matching tools become available from the next step.`; `query`: `What the tool should do, in a few words.`; `limit`: `How many tools to return (1 to 20, default 5).` |
| Search result (§6.8) | `[engine] Tools available from the next step: <a>, <b>.` and / or `Part of skills, load the skill first: <tool> (<skill>), …` |
| Search without a match (§6.8) | `[engine] No tools match "<query>". Try other words for what the tool should do.` |
| Format check header (§5.4) | `[Format check] The <fence> block failed validation:` |
| Format check footer (§5.4) | ``Send only the corrected ```<fence>``` block, with no text before or after.`` |
| Invalid JSON in a block (§5.4) | `JSON did not parse: <reason>` |
| Unclosed / missing block (§5.4) | `the block is not closed: no ``` line after the JSON` / ``the answer has no ```<fence> block`` |
| More errors than fit (§5.4) | `…and N more` |
| Validator messages (§5.4) | ajv messages in the locale (ajv-i18n for `ru`) |
| `error.message` of a failed run (§7, §12.1) | provider refusals (401 / 403 / 429 / 5xx / 4xx), context too large, TLS, a stream without `finish-step`, `run_timeout`, `provider_queue_timeout`, `image_fetch_failed`, internal error — e.g. `the provider is unavailable (HTTP 503)` |

The `ru` catalog contains the same entries in Russian (`src/i18n.ts`); validator messages
come from ajv-i18n. Adding a locale means adding a catalog with the same keys.
The `[engine]` prefix is constant: it tells the model the line comes from the platform,
not from the user.
