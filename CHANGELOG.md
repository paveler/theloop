# Changelog

All notable changes to theloop. The contract is versioned separately (`contract_version: "1"`,
[SPEC.md](SPEC.md)); every change below is additive to it. Releases follow semver: no breaking
changes within 1.x.

## v1.1.2 — 2026-10-27

No breaking contract changes. SPEC §6.5 now spells out the cancelled deferred call, and
Appendix A gains H21.

### Fixed

- **Cancel with a deferred call in the batch** (SPEC §6.5). When a write tool had already
  answered `deferred` and a parallel read was still running, cancel left the deferred
  `tool_call` without a tool message, and the next run with that history was refused with
  `unresolved_tool_call`. Every terminal status other than `awaiting_tool` now closes such
  a call with `cancelled`; its `tool_calls[]` entry keeps the `operation_id`, so the
  harness can cancel the operation (new obligation H21).
- **Cancel during an image download** (SPEC §6.5). The aborted download surfaced as
  `image_fetch_failed` and the run ended `failed`; an aborted run now ends by its abort
  reason (`cancelled`, or `failed` / `run_timeout`).
- **Repeated calls and `max_tool_calls`** (SPEC §6.7). The limit was checked before repeats
  were detected, so a repeat could end the run `stopped_limit`. Repeats are not executed
  and no longer count; the model gets `repeated_call` and goes on.
- **Output estimate without provider usage** (SPEC §8.2). Generated tool calls (name and
  arguments) are now counted, not only text and reasoning.
- **Prompt estimate and date lines** (SPEC §5.1, §9.4). The per-message date lines from
  `created_at` were added to the prompt after the estimate, so trimming and
  `max_total_tokens` ran on a smaller number than the prompt actually sent.

### Example harness

- **A new amount updates the pending operation** (SPEC §6.4). "Refund 60 instead of 120"
  created a second operation and left the card for 120 confirmable. The pending comparison
  now matches by the subject (the order); a changed amount updates the operation and bumps
  its version.
- **A callback before the `POST /runs` response** is recorded and applied once the run row
  exists; it used to be lost until recovery.
- **An operation that is already closed** (rejected at registration, executed before a
  replay) continues the conversation at once instead of leaving the session in
  `awaiting_tool`.
- **H21:** a deferred call closed by `cancel` cancels its operation.

### Security

- **Callback diagnostics.** A receiver that echoed the request in its error body could put
  the `CALLBACK_SECRET` value, a `callback.headers` value or a callback query value into
  `last_error`, the event journal and stdout. These values are now redacted wherever they
  occur, raw, JSON-escaped or URL-encoded.

## v1.1.1 — 2026-10-27

No contract changes.

### Fixed

- **Signed Claude thinking after the engine's own edits** (SPEC §9.3). Claude Fable 5.1,
  Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking block to the exact prefix before it;
  on accounts created on or after 2026-08-31 a replayed block after a change is a `400`.
  Trimming (§5.1) and a user message without `created_at` that lost its current-time line
  (§9.4) are such changes. On those steps the engine now sends
  `block_binding: { prefix_mismatch_behavior: "drop_block" }`: the provider drops the stale
  blocks and the run goes on. Drops are journaled as `thinking_blocks_dropped`.
- **Claude context window: 1M.** The built-in profile assumed 200k for every `claude-*`, so
  the engine trimmed Claude histories five times too early. Now 1M, 200k only for Claude 3,
  Opus / Sonnet 4.0, Opus 4.1 and the 4.5 models.

### Security

- **Dependencies with known advisories updated:** `hono` 4.13, `@hono/node-server` 1.19.17,
  `undici` 7.30.1, `fast-uri` 3.1.9 (transitive). `npm audit` reports none.
- **Zod 4.** Zod 3 accumulates an issue for every failing array element without a cap
  (GHSA-mrhx-c7xc-m3w5), so a large invalid body could exhaust memory before the request
  is refused. Error codes and paths in `400 bad_request` are unchanged; the human-readable
  part of the message now comes from Zod 4 (`Invalid input: expected string, received
  number` instead of `Expected string, received number`).

## v1.1.0 — 2026-10-27

Contract changes are additive: a request that does not use the new fields behaves exactly as
before.

### Added

- **Skills** ([RFC 0001](docs/rfcs/0001-skills-and-deferred-tools.md), SPEC §6.8). `skills[]` in
  the request, in the `SKILL.md` shape: `{ name, description, body, tools }`. The engine appends
  an index (name and description, sorted by name) to `system` and offers a built-in tool
  `load_skill`. It returns the skill's instructions and makes the skill's tools available from
  the next step.
- **Deferred tools.** `tools[].defer_loading: true` keeps a tool out of the model's context
  until a skill or a search activates it. A call to a tool that is not loaded yet gets
  `tool_not_loaded`: it is not executed, does not count toward `max_tool_calls` and is not
  treated as a repeat.
- **`search_tools`.** A built-in tool offered when a deferred tool belongs to no skill. It runs
  BM25 over tool names, descriptions and argument names, works the same on every provider and
  is reproducible from the request. Matches activate from the next step; matches that belong to
  a skill point the model to `load_skill`.
- **The prompt cache survives activation.** On Anthropic models with tool search, activated
  tools arrive as `tool_reference` blocks inside the conversation, so the cached prefix never
  changes. On other providers the next step's tools array grows: one prefix cache miss per
  activation.
- **Still stateless.** What is loaded is derived from the history on every run, from `tool`
  messages the engine marks `builtin: true` (harness obligation H20). Trimming never drops a
  turn that carries an activation in effect.
- Built-in calls appear in `tool_calls[]` with `builtin: true`. New journal events:
  `skill_loaded`, `skill_unknown`, `skills_restored`, `tool_search`,
  `builtin_history_invalid`.
- [`examples/sqlite-harness`](examples/sqlite-harness): a complete harness on SQLite with no
  dependencies, end to end, with a chat in the terminal (`npm run example:sqlite`).

### Changed

- **Vercel AI SDK 6** (`ai` 6.0, `@ai-sdk/anthropic` 3.0, `@ai-sdk/openai-compatible` 2.0).
  Usage is read from the SDK's unified split of uncached, cache read and cache write tokens;
  billing still records the uncached input (SPEC §8.1). On `tool_choice: none` steps Anthropic
  now keeps the tools array and receives `tool_choice: { type: "none" }`.
- README: a banner, badges, a comparison with neighbouring tools, and a quickstart with the
  published image.

## v1.0.1 — 2026-10-15

- **Fix: the quickstart works.** `npm run dev` and `npm start` read `.env`. Before,
  `cp .env.example .env` followed by `npm run dev` failed with `ENGINE_TOKEN is required`.
  Node 22.9+ is required.
- **Docs: the trust model.** README states what "a prompt-injected model can ask, not act"
  depends on, and what the engine guarantees itself.
- **Docs: `AGENTS.md`**, one instruction file for any coding agent.
- **Images.** Every `vX.Y.Z` tag publishes `ghcr.io/paveler/theloop` after typecheck and tests.

No contract changes.

## v1.0.0 — 2026-10-15

First public release: the agent loop as a stateless HTTP service.

- **Contract:** [SPEC.md](SPEC.md), `contract_version: "1"`. One `POST /runs` is one run, with
  everything in the request. SSE with replay, synchronous cancel, at-least-once callback with
  `GET /runs/{id}` recovery, and a session lock held until `ack`.
- **Loop:** driven step by step; tools run only after `finish-step`; limits at the step
  boundary; detectors for repeated calls and empty results; a format gate for fenced blocks
  with repair steps.
- **Write intents:** a tool with `effect: write` must answer `deferred`; approvals live in the
  harness.
- **Usage:** one record per provider attempt (`ok | failed | unknown`), cache tokens, optional
  cost, estimated budgets.
- **Providers:** Anthropic, OpenAI, DeepSeek, GLM, GigaChat, MiniMax and any OpenAI-compatible
  endpoint, with a per-key queue and AIMD.
- **Operations:** controlled egress, provider proxies, graceful shutdown, an error webhook, an
  in-memory event journal, engine text in `en` / `ru`.
