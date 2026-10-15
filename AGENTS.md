# AGENTS.md — instructions for coding agents

This file is for any AI coding agent working in this repository (Codex, Cursor, Copilot,
Gemini CLI, Aider, Claude Code and others) and for humans who want the short version.
`CLAUDE.md` imports it; there is no other agent-specific instruction file.

## What this is

theloop is an agent loop as a stateless HTTP service. One `POST /runs` is one run: the
request carries provider, model, key, prompt, the full history, tools (URL + schema) and
limits. The engine runs "model → tools → model", streams text over SSE, delivers the result
and usage by callback, and forgets the run. Backend only, no UI. Node 22, TypeScript (ESM),
Hono, Vercel AI SDK 5, vitest.

Documents, in order of authority:

1. `SPEC.md` — the frozen v1 contract (`contract_version: "1"`). Read the relevant section
   before any task. If you are unsure how something must behave, the SPEC decides, not the
   current code.
2. `README.md` — overview, quickstart and the code map.
3. `ROADMAP.md` — proposals. Not part of the contract; do not implement roadmap items unless
   the task asks for it.

## Setup and commands

```bash
npm install
cp .env.example .env      # ENGINE_TOKEN + provider keys, only for dev / smoke
npm run dev               # tsx watch, reads .env, http://localhost:8080 (Node 22.9+)
npm test                  # vitest — no network, no keys
npm run typecheck         # src and tests
npm run smoke             # live run against real providers (needs keys; never in CI)
npm run build && npm start
```

Before you finish any change: `npm run typecheck && npm test` must pass. CI
(`.github/workflows/check.yml`) runs the same on every PR and on `main`; merge on green only.
Do not run `npm run smoke`, `smoke:gigachat` or `spike:reasoning` unless asked: they call
paid provider APIs.

## This repository is public

- English everywhere: code, comments, docs, test names, commit messages, PR descriptions.
- Never reference private deployments, customers, downstream products or internal project
  names in code, docs, examples, fixtures or commits. Examples use neutral domains
  (`example.com`, `example.net`) and neutral businesses (an online store, a help desk).
- No secrets, real keys, real endpoints or production measurements tied to a deployment.
  `.env` is git-ignored; keep it that way.
- No emojis in code, logs, API responses or docs.
- Cyrillic is allowed only in the `ru` catalog of `src/i18n.ts` and in tests that check the
  `ru` locale or Cyrillic handling.

## Architecture rules

The SPEC is authoritative; this is the short list of rules that are easy to break.

- **Everything in the request, nothing in the engine.** No database, no stored configs, no
  memory, no tenant registry. State lives in the harness (the client). Personal-agent
  features (memory, channels, schedulers) grow in separate layers — see ROADMAP — never in
  the kernel.
- **Runs are ephemeral.** In memory until a terminal status plus retention (§3, §11.5). One
  logical result, at-least-once callback, `GET /runs/{id}` for recovery. The session lock is
  held until `ack` (§3.1); `idempotency_key` is checked before the lock.
- **The loop is driven step by step by hand** (`src/runs/runner.ts`): one `streamText` call per
  step, tool calls are executed only after `finish-step`. Do not switch to the SDK loop
  (`stopWhen`, tools with `execute`). A provider attempt is retried only before its first
  content event (§11.3).
- **Usage is billing-grade** (§8): one record per provider attempt (`ok | failed | unknown`),
  SDK retries off (`maxRetries: 0`), `input_tokens` uncached, cache read / write separate,
  interrupted attempts estimated with `estimated: true`. Budgets are checked before every
  attempt, `unknown` counts at worst case (§10.2).
- **Tools are HTTP endpoints** (§6). Answers `ok | error | accepted | deferred`; a tool error
  goes to the model and does not fail the run. `effect` is mandatory. A `write` tool only
  registers an intent and must answer `deferred` with an `operation_id`; the engine never
  executes mutations and has no approval logic. Two calls of one write tool in a step →
  `duplicate_write_intent`. `call_id` is transport idempotency only.
- **Cancel keeps the invariant** (§6.5): partial text is kept, every unresolved `tool_call`
  gets a synthetic tool error. There is no preempt.
- **Limits at the step boundary** (§10.1): tools of the last allowed step are not executed;
  a batch larger than the remaining `max_tool_calls` is not executed at all.
- **Controlled egress** (§11.4): every outbound request (tools, callback, images,
  `openai-compatible`) goes through `src/egress/client.ts` — HTTPS, `EGRESS_ALLOWLIST`, no
  private addresses, no redirects, only `Authorization` and `X-*` headers. Env provider keys
  never go to an arbitrary `base_url`. SDK adapters never fetch URLs themselves.
- **Secrets never leak**: provider keys, `ENGINE_TOKEN`, `CALLBACK_SECRET`, run / call tokens
  and tool / callback header values never appear in logs, the journal, SSE, callbacks or error
  bodies. `ENGINE_TOKEN` has no default.
- **The history between turns is only appended to** (§9.3, §9.4): dates go into user messages
  (from `created_at`), never into `system`; tools are sent sorted by name. Anything that
  changes between turns placed in or before the history breaks the prompt cache and signed
  thinking blocks.
- **SSE by default carries only text and anonymized tool progress** (§6.6); args, results and
  reasoning only behind `stream.expose_*`.
- **Graceful shutdown is mandatory** (§11.1): no run is lost silently on SIGTERM.
- **No CAS / lease / fencing / durable step machines.** One process, an in-process lock;
  scaling out is sticky routing or Redis, later.

## Code conventions

- ESM with `.js` extensions in relative imports (`import { x } from './y.js'`); strict
  TypeScript with `noUncheckedIndexedAccess`.
- Request and message shapes are zod schemas in `src/contracts.ts`. Change the contract there
  and in `SPEC.md` together.
- Errors that map to an HTTP status or a failed run are `EngineError(code, message,
  details?)` with a code from `src/errors.ts` (§12.1). Codes are stable; messages are for
  humans.
- Logging goes through `log.*` from `src/log.ts`: `log.info(event, fields, content?)`.
  Metadata goes to stdout and the journal; the third argument (prompts, texts, args, results)
  goes only to the in-memory journal. Every new loop decision (a limit, a refusal, a retry, a
  detector) is a new named event, added to the SPEC §12.4 catalog. The bare `logger()` is for
  the access log only.
- Text the engine writes for the model, and failed-run `error.message`, comes from the locale
  catalog in `src/i18n.ts` — add the key to both `en` and `ru`. Never hard-code such strings.
  HTTP 4xx messages, config errors and log text are plain English.
- Comments explain why, not what; keep them short and reference SPEC sections (`§6.4`).
- No new runtime dependency without a clear reason. A major upgrade of the AI SDK needs the
  reasoning round-trip spike re-run (`scripts/spike-reasoning.ts`, SPEC §5.2).

## Tests

- vitest, no network, no keys. Models are mocked with `MockLanguageModelV2` through
  `mockModel` / `mockFactory` in `test/helpers.ts`; tools and callbacks are local HTTP servers
  from `startServer`; the engine is driven in-process with `engine.app.request`.
- Every behavior in the SPEC has a test; every bug fix comes with a test that fails without
  it. Do not delete, skip or weaken tests to make a change pass.
- Default engine locale is `en` and default time zone `UTC`; tests about other locales or
  zones set them explicitly (`meta.locale`, `meta.timezone`).
- Format-gate fixtures are synthetic (`test/fixtures/rule-card.*`); keep them neutral.

## Changes, commits, releases

- Work on a branch, open a PR against `main`. A change to the API, the message format or
  status semantics updates `SPEC.md` in the same PR; additive changes keep
  `contract_version: "1"`.
- Commit messages: English, conventional prefix (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`), a subject that says what changed, a body that says why.
- Releases are git tags `vX.Y.Z` on `main` (semver) with the matching `version` in
  `package.json` — `/health` reports it. Pushing a tag runs `.github/workflows/release.yml`:
  tests, then the image `ghcr.io/paveler/theloop:X.Y.Z`. Each release also gets a GitHub
  Release with notes. Downstream deployments consume tags, not `main`, so `main` may move
  between releases but must stay green.
