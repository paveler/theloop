# theloop — guidelines for code agents

## What this is

theloop is an agent loop as a stateless HTTP service: one `POST /runs` = one run, everything
(provider, model, key, prompt, history, tools, limits) comes in the request, the result and
usage go out by callback, and the engine forgets the run. Backend only, no UI.

**Main documents:** `SPEC.md` (the frozen v1 contract) and `ROADMAP.md` (proposals, not
contract). Before any task, read the relevant SPEC section. A change to the API, the message
format or status semantics updates `SPEC.md` in the same branch.

## This repository is public

- English everywhere: code, comments, docs, commit messages, PR descriptions.
- Never reference private deployments, customers, downstream products or internal project
  names in code, docs, examples, test fixtures or commits. Examples use neutral domains
  (`example.com`) and neutral businesses (an online store, a help desk).
- No secrets, real keys, real endpoints or production measurements tied to a deployment.
- No emojis in logs, API responses or docs.

## Architecture rules (summary — SPEC is authoritative)

- Everything in the request, nothing in the engine: no database, no configs, no memory.
  State lives in the harness. Personal-agent features grow in separate layers (ROADMAP),
  never in the kernel.
- One logical result, at-least-once delivery; the session lock is held until `ack`.
- Usage: one record per provider attempt (`ok | failed | unknown`), SDK retries off.
- Tools are POSTs to URLs from the request; `effect: write` must answer `deferred`; the
  engine never runs mutations and has no approval logic.
- The loop is driven step by step manually; tool calls run only after `finish-step`.
- Controlled egress through one HTTP client; keys never in logs, journal, SSE, callbacks or
  error bodies.
- The history between turns is only appended to (prompt cache, signed thinking).
- Engine-injected text goes through the locale catalog (SPEC Appendix B).
- Every new loop decision is a named event in the SPEC §12.4 catalog.
- No CAS / lease / fencing / durable step machines.
