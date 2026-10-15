# theloop

**The agent loop as a stateless HTTP service.** One `POST /runs` is one run. The request
carries everything: provider, model, key, prompt, full history, tools (URL + schema), limits.
theloop runs "model → tools → model", streams text over SSE, delivers the result and
billing-grade usage by callback — and forgets the run.

Built for teams that ship assistants to many users: multi-tenant by construction, per-request
keys, one usage record per provider attempt, write tools as intents that your system approves
and executes.

> Status: v1.0 — the contract is frozen ([SPEC.md](SPEC.md)) and implemented: Node 22,
> TypeScript, Hono, Vercel AI SDK 5. Tests run without network or keys.
> "1.0" is a promise about the contract (semver: no breaking changes within 1.x), not a claim
> of operational maturity — the implementation is young; expect fixes, not contract changes.

## Why

- **Everything in the request, nothing in the engine.** No database, no configs, no tenant
  registry. Your backend decides what the assistant is on every call.
- **One result, at-least-once.** Callback with retries, deduplication by `run_id`, results
  readable via `GET /runs/{id}` for recovery, late results placed by history revision.
- **Writes are intents.** A tool with `effect: "write"` answers `deferred` with an operation
  id; the mutation happens in your system after approval — never inside a tool call. With
  tools built that way, a prompt-injected model can request an action but cannot carry it
  out — see [Trust model](#trust-model) for what that depends on.
- **Usage you can bill.** Every provider attempt, including failed and interrupted ones, with
  uncached input, cache read / write and an explicit `estimated` flag. Optional cost from your
  price list, with token and cost budgets.
- **Controlled egress.** HTTPS only, host allowlist, no private IPs, no redirects, header
  filtering; provider keys never in logs, SSE, callbacks or error bodies.
- **Providers.** Anthropic, OpenAI, DeepSeek, GLM (z.ai), GigaChat, MiniMax and any
  OpenAI-compatible endpoint, with per-key queues and AIMD rate limiting.
- **Debuggable.** An in-memory event journal per run and session (`GET /logs`), with content,
  without shipping prompts to your log pipeline.

## Quickstart

```bash
git clone https://github.com/paveler/theloop.git && cd theloop
npm install
cp .env.example .env      # set ENGINE_TOKEN and at least one provider key
npm run dev               # reads .env; http://localhost:8080 (Node 22.9+)
```

One synchronous run (`wait: true`), with the Anthropic key taken from `ANTHROPIC_API_KEY`:

```bash
curl -s http://localhost:8080/runs \
  -H "Authorization: Bearer $ENGINE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "contract_version": "1",
        "llm": { "provider": "anthropic", "model": "claude-sonnet-5" },
        "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello!" } ] } ],
        "wait": true }'
```

Without `wait`, the response carries `stream_url` (SSE) and `cancel_url`, and the result goes to
`callback.url`. Tools, write intents, limits and everything else — [SPEC.md](SPEC.md).

**Next: a whole integration.** [`examples/sqlite-harness`](examples/sqlite-harness) is a complete
harness on SQLite with no dependencies — history, a read tool, a write tool with approval, the
continuation of the conversation, recovery — and a chat in the terminal:
`npm run example:sqlite`.

Docker, without cloning — images are published on every release:

```bash
docker run -p 8080:8080 -e ENGINE_TOKEN=change-me -e ANTHROPIC_API_KEY=sk-ant-… ghcr.io/paveler/theloop:1
```

Or build your own: `docker build -t theloop . && docker run -p 8080:8080 --env-file .env theloop`.

## Trust model

The engine enforces what it can see; your tool endpoints carry the rest. The "a model can ask,
not act" property holds only if all of the following are true:

- **Write endpoints only register an intent** (SPEC §6.4): create or find an operation, answer
  `deferred` with its id, change nothing. The engine flags a write tool that answers anything
  else as `tool_protocol_error`, but it detects after the call — it cannot undo a mutation the
  endpoint already made.
- **Tools marked `read` really have no side effects.** The engine trusts `effect`: a mutating
  tool labelled `read` is executed synchronously, with no `deferred` and no approval. This is
  the easiest way to break the model.
- **Approval and execution happen in your system**, with the operation version checked and the
  operation id passed downstream as the idempotency key (§6.4).
- **Tool endpoints scope data by `meta`** (tenant, user) from the engine call, never by ids in
  `args` — the model can put any id there.
- **Only trusted servers hold `ENGINE_TOKEN`**: whoever has it chooses prompts, tools and
  endpoints. End-user clients get run-scoped tokens only.

What the engine guarantees on its side: it never executes a mutation itself, it does not
execute two calls of one write tool in one step, it refuses write tools without the context
needed for idempotency (`write_context_missing`), it validates tool arguments before calling
an endpoint, and all outbound requests go through the egress allowlist.

## How it fits

```
end-user client ── SSE, cancel (run token) ──► theloop ◄── POST /runs, GET, ack ── your harness
                                               │     │                               ▲
                                    tool calls │     └── callback: result + usage ───┘
                                               ▼
                                     your tool endpoints
```

The **harness** is your backend (or a low-code platform, or a workflow tool): it stores
history, assistants, tools and operations, and owns approvals and billing. Its obligations
are listed in [SPEC.md, Appendix A](SPEC.md#appendix-a-harness-obligations).

## Code map

```
src/
  index.ts              entry point: env → engine → HTTP, SIGTERM
  app.ts                Hono routes, CORS, auth, body limit, graceful shutdown
  config.ts             env (SPEC §14)
  contracts.ts          zod: RunRequest, StoredMessage, ToolResponse, RunResult
  errors.ts             error codes and their HTTP statuses (§12.1)
  i18n.ts               engine-injected text, en / ru (Appendix B)
  log.ts, log-buffer.ts structured events; the in-memory journal for GET /logs (§12.4)
  alerts.ts             error webhook (§12.3)
  runs/registry.ts      in-memory runs: status, SSE buffer, tokens, session lock, idempotency
  runs/runner.ts        the loop, step by step: one streamText per step → finish-step →
                        limits → tools → next step
  runs/provider.ts      one provider attempt, error classification
  runs/messages.ts      StoredMessage ↔ ModelMessage, context estimate and trimming, dates
  runs/output-checks.ts the format gate for fenced blocks (§5.4)
  runs/usage.ts         attempts ok / failed / unknown, normalization, cost, budgets
  runs/callback.ts      at-least-once result delivery
  runs/validate.ts      request validation
  runs/images.ts        image validation and download through egress
  tools/http.ts         tool calls: ok / error / accepted / deferred, effect control, retries
  tools/args.ts         conservative argument validation against input_schema
  egress/               the single outbound HTTP client: allowlist, private IPs, no redirects
  stream/sse.ts         SSE with replay, snapshot, gap, backpressure
  providers/            allowlist, model factory, GigaChat OAuth and translator, per-key queue
```

## Development

```bash
npm test                  # vitest, no network, no keys
npm run typecheck
npm run smoke             # live run against real providers, keys from .env (not in CI)
npm run build && npm start
```

## Documents

- [SPEC.md](SPEC.md) — the contract: API, message format, loop semantics, limits, reliability.
- [ROADMAP.md](ROADMAP.md) — proposals: MCP, more providers, skills, compaction, sub-runs, a
  reference harness with channels and memory.
- [examples/sqlite-harness](examples/sqlite-harness) — a complete harness: what your backend does
  around the engine, obligation by obligation.
- [AGENTS.md](AGENTS.md) — how to work on the code: commands, architecture rules, conventions,
  tests, releases. Written for AI coding agents; a good short version for contributors too.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
