# theloop

**The agent loop as a stateless HTTP service.** One `POST /runs` is one run. The request
carries everything: provider, model, key, prompt, full history, tools (URL + schema), limits.
theloop runs "model → tools → model", streams text over SSE, delivers the result and
billing-grade usage by callback — and forgets the run.

Built for teams that ship assistants to many users: multi-tenant by construction, per-request
keys, one usage record per provider attempt, write tools as intents that your system approves
and executes.

> Status: the v1 contract is frozen ([SPEC.md](SPEC.md)). The reference implementation
> (Node 22, TypeScript, Hono, Vercel AI SDK 5) is being prepared for publication.

## Why

- **Everything in the request, nothing in the engine.** No database, no configs, no tenant
  registry. Your backend decides what the assistant is on every call.
- **One result, at-least-once.** Callback with retries, deduplication by `run_id`, results
  readable via `GET /runs/{id}` for recovery, late results placed by history revision.
- **Writes are intents.** A tool with `effect: "write"` answers `deferred` with an operation
  id; the mutation happens in your system after approval — never inside a tool call. A
  prompt-injected model can ask, it cannot act.
- **Usage you can bill.** Every provider attempt, including failed and interrupted ones, with
  uncached input, cache read / write and an explicit `estimated` flag. Optional cost from your
  price list, with token and cost budgets.
- **Controlled egress.** HTTPS only, host allowlist, no private IPs, no redirects, header
  filtering; provider keys never in logs, SSE, callbacks or error bodies.
- **Providers.** Anthropic, OpenAI, DeepSeek, GLM (z.ai), GigaChat, MiniMax and any
  OpenAI-compatible endpoint, with per-key queues and AIMD rate limiting.
- **Debuggable.** An in-memory event journal per run and session (`GET /logs`), with content,
  without shipping prompts to your log pipeline.

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

## Documents

- [SPEC.md](SPEC.md) — the contract: API, message format, loop semantics, limits, reliability.
- [ROADMAP.md](ROADMAP.md) — proposals: MCP, more providers, skills, compaction, sub-runs, a
  reference harness with channels and memory.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
