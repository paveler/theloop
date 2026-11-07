# Python client example

A minimal harness-side client in one script: starts a run, follows `stream_url` over
SSE, prints the answer and the usage. The only dependency is
[`httpx`](https://www.python-httpx.org) (Python 3.10+).

Terminal 1 — the engine, per the [README quickstart](../../README.md#quickstart):

```bash
npm install
cp .env.example .env      # set ENGINE_TOKEN and at least one provider key
npm run dev               # reads .env; http://localhost:8080
```

Terminal 2 — the client:

```bash
pip install httpx
ENGINE_TOKEN=... python client.py "Hello!"
```

The text arrives live as the model speaks, then a final block with the status, the
timing and the usage:

```
run run_01J…
model anthropic/claude-sonnet-5
Hello! ...
status: completed (finish_reason: end_turn)
timing: 4210 ms, 1 steps
usage: 1820 input, 96 output, 0 cache read, 0 cache write, 0 reasoning tokens; 1 calls (0 unknown), estimated
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ENGINE_URL` | `http://localhost:8080` | Where the engine runs |
| `ENGINE_TOKEN` | — | Required; the same value the engine uses |
| `LLM_PROVIDER` | `anthropic` | Any provider from [SPEC §9.1](../../SPEC.md) |
| `LLM_MODEL` | `claude-sonnet-5` | Free-form, validated by the provider |
| `LLM_API_KEY` | — | Per-request key; absent → the engine's env key (SPEC §9.1) |
| `LLM_BASE_URL` | — | For `openai-compatible` (https, or http://localhost with `ALLOW_INSECURE_EGRESS=1`) |

## Notes

- The script holds `ENGINE_TOKEN`, so it runs on the harness side (SPEC §4.1). An
  end-user client would only ever hold `stream_url` with the run token.
- Without `callback.url` the contract allows only `wait: true`, whose response arrives
  only after the run ends (SPEC §7). The script starts the run with a background
  request carrying an `idempotency_key`, then repeats the same request to get the
  `stream_url` of the running run at once (SPEC §11.2) — the same approach as
  `scripts/sse-check.ts`.
- A dropped stream is reconnected with `Last-Event-ID` (SPEC §6.6); a closed stream
  cancels nothing — the run finishes on its own.
