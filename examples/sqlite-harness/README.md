# Example: a complete harness on SQLite

theloop is stateless: everything durable — the history, operations, approvals — lives in the
**harness**, the backend that calls the engine. This example is a whole harness in about 700
lines with comments and no dependencies (`node:sqlite`, `node:http`). It shows what theloop
does for you and what is left to your side.

The demo is the help desk of an online store:

- `getOrder` — a **read** tool: the engine calls it and the answer goes straight to the model;
- `refundOrder` — a **write** tool: it only registers a refund intent and answers `deferred`;
  the money moves after the customer approves, and the conversation continues.

## Run it

```bash
cp .env.example .env       # ENGINE_TOKEN, ALLOW_INSECURE_EGRESS=1, a provider key
npm run dev                # terminal 1: the engine on :8080
npm run example:sqlite     # terminal 2: the harness on :3100, a chat in the terminal
```

`ALLOW_INSECURE_EGRESS=1` lets the engine reach the harness at `http://localhost:3100` (dev
only). The model defaults to `anthropic` / `claude-sonnet-5` with `ANTHROPIC_API_KEY` from the
engine's env; set `LLM_PROVIDER` / `LLM_MODEL` for another one. Requires Node 22.13+ for
`node:sqlite`.

```
> Where is my order 1042?
[getOrder]
Order 1042 was delivered on …
> Please refund it.
[refundOrder]
I've requested a refund of 120 — please confirm it.
  approval needed: refund 120 for order 1042 — /approve op_3f… or /reject op_3f…
> /approve op_3f…
The refund of 120 for order 1042 went through.
```

`/history` prints the stored `StoredMessage` history — exactly what the next run receives.
The state survives restarts in `harness.db`.

## What the harness does

| File | Part |
|---|---|
| [`store.ts`](store.ts) | SQLite: sessions, messages, runs, operations, opref references, demo orders |
| [`harness.ts`](harness.ts) | the engine client and every obligation below |
| [`main.ts`](main.ts) | the terminal chat: SSE streaming, approvals, periodic recovery |

How it covers the harness obligations of [SPEC Appendix A](../../SPEC.md#appendix-a-harness-obligations):

| | Where |
|---|---|
| H1 full history, last message `user` / `tool` · H2 `created_at` on user messages | `send`, `store.history` |
| H3 `idempotency_key` = message id, `meta.session_id`, `history_revision` | `startRun` |
| H4 idempotent writes: run by `run_id`, message by `<run_id>:<seq>`, tool result by `call_id` | `applyResult`, `store.putMessage` |
| H5 callback answers 2xx only after the write — that is the ack | `handle` → `/callback` |
| H6 dedup by `run_id`, `X-Engine-Secret` check | `applyResult`, `handle` |
| H7 explicit ack after `GET` / `cancel` | `fetchAndApply`, `cancel` |
| H8 deadline: `GET` before declaring a run lost, only `404` is lost | `recover` |
| H9 a late result for an older revision is audit, not a turn | `applyResult` |
| H10 `409 result_pending` / `session_busy` → fetch, record, ack, retry | `startRun` |
| H11 interrupt = synchronous `cancel` → record → new run | `send` |
| H12 a message during `awaiting_tool` supersedes the call; the late result comes as an `event` part | `send`, `continueAfter` |
| H13 continue only when every deferred call has a result | `continueAfter` |
| H14 write endpoint: origin lookup → pending comparison → create; always `deferred` | `registerRefund` |
| H15 mutation only after approval, version checked, operation id as the downstream idempotency key | `decide`, `store.refund` |
| H16 tool data scoped by `meta.user_id`, never by ids from `args` alone | `callTool` |

Not covered, on purpose: multi-tenancy, encrypted key storage, usage accounting and
reconciliation (H19), a web UI. Each is a table and a page in a real product.

## Tests

[`test/example-sqlite-harness.test.ts`](../../test/example-sqlite-harness.test.ts) runs this
harness against the engine with a mock model — no network, no keys: the whole read → intent →
approval → continuation path, duplicate deliveries, write-endpoint idempotency, supersede with a
late result, and recovery of a lost callback.
