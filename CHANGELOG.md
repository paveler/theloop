# Changelog

All notable changes to theloop. The contract is versioned separately (`contract_version: "1"`,
[SPEC.md](SPEC.md)); every change below is additive to it. Releases follow semver: no breaking
changes within 1.x.

## Unreleased

On `main`, not tagged yet. Contract changes are additive: a request that does not use the new
fields behaves exactly as before.

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
