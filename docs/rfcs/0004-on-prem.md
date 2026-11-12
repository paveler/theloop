# RFC 0004: On-prem and closed-network deployment

| | |
|---|---|
| Status | Implemented in v1.5.0 (2026-11-12) |
| Scope | Additive. Every new behavior is opt-in through env or a new request field; with no new env set, the engine behaves exactly as v1.4.x, with one deliberate tightening (§6.8) |
| Target | v1.5.0 (`contract_version` stays `"1"`) |
| Touches | SPEC §4.2, §4.7, §4.9, §5.2, §7, §8, §9.1, §9.5, §11.4, §11.6, §12.2–§12.4, §13, §14, §15, Appendix A; `src/config.ts`, `src/log*.ts`, `src/alerts.ts`, `src/egress/*`, `src/providers/*`, `src/contracts.ts`, `src/runs/*`, `src/app.ts`, `src/index.ts`, `Dockerfile`, `.github/workflows/release.yml` |

## 1. Summary

theloop today assumes a cloud deployment: models are public SaaS APIs, tools live on public
HTTPS hosts, and the operator is fine with the journal holding prompts and answers. An on-prem
installation in a closed network (no internet, internal models, internal tools, strict data
rules) breaks each of these assumptions. This RFC makes theloop installable and operable in such
a network without forking it:

- **A. Egress into a private network** — private addresses and plain HTTP only for ranges and
  hosts the operator names; public provider hosts can be switched off.
- **B. Self-hosted and gateway models** — base URL overrides for named providers and
  operator-defined model endpoints (vLLM, Ollama, TGI, an internal LLM gateway) with their own
  capabilities, context window, reasoning policy and concurrency.
- **C. Content-free logging** — one switch, with per-class granularity and a per-request
  ceiling, that guarantees no prompt, message, tool payload or externally sourced text reaches any
  engine sink (stdout, memory journal, disk journal, error webhook), enforced by a per-event field
  registry and a canary conformance test.
- **Local models as a supported path** — Ollama first, vLLM for load: compose recipe, offline
  model delivery, the context-window trap, wire quirks covered by fixtures, a live smoke.
- **D. Air-gapped delivery** — an image and a plain Node bundle that install from files, with
  checksums, a signature, an SBOM and third-party licenses; a non-root, read-only-rootfs image;
  a test that the engine makes no outbound connection on its own.
- **E. Operations without SaaS** — secrets from files, Prometheus metrics, a minimal `/health`.

## 2. Motivation

What fails today in a closed network, in the order an installer hits it:

1. **Install.** The only artifact is a registry image. There is no file artifact, no checksum or
   signature to verify offline, no SBOM for the security review. The image runs as root, which
   most internal platforms (OpenShift, hardened Kubernetes) refuse.
2. **Secrets.** Keys and `ENGINE_TOKEN` are plain env. Internal platforms mount secrets as files.
3. **The model.** The model is internal: `https://llm.corp.internal/v1` resolving to
   `10.20.30.40`, sometimes plain `http://`, often without a key. `openai-compatible` requires an
   `api_key` and HTTPS, and the egress client refuses every private address unconditionally
   (§11.4). Named providers cannot be pointed at an on-prem installation of the same API (a
   self-hosted GigaChat, a corporate gateway in front of Anthropic / OpenAI): their `base_url` is
   built in. Window and capabilities of an unknown local model fall back to conservative defaults
   unless every request repeats them.
4. **Tools and callback.** Same egress wall: internal hosts on private addresses, sometimes HTTP
   inside the segment.
5. **Data rules.** The journal records prompts, history, model output, tool arguments and results
   by default (§12.4). `LOG_BUFFER_CONTENT=0` exists, but it is not a guarantee: provider and
   network error text, callback receiver responses, exception messages (which quote parsed
   input), URL paths, model-invented tool names and webhook `meta` all stay, and nothing tests the
   whole surface. A security officer needs "content never reaches engine logs" as a testable
   property, not as a reading of the code.
6. **Monitoring.** There is no SaaS log pipeline; there is Prometheus. theloop exposes no metrics.

## 3. Non-goals

- Multi-instance / HA (still §15).
- A TLS listener on the engine: terminate TLS at a reverse proxy / ingress, as today. (Deferred:
  it drags TLS-aware probes, healthchecks and CA handling into this release, §10.)
- Encryption of the disk journal at rest: use volume encryption.
- National-standard TLS cipher suites (e.g. GOST): terminate them at a proxy in front of or
  behind the engine; Node's TLS stack does not carry them.
- A harness, an approval UI, a tool server — unchanged boundaries (§2).
- Telemetry, license checks, update checks — theloop has none; this RFC makes that a tested
  property (§7.3), not a feature.

## 4. Part A — Egress into a private network

Current rules (§11.4) stay the default. Three env variables relax them for named targets only.

### 4.1 Address normalization and unconditional denies

Every address check — DNS answers, IP literals in URLs, CIDR entries — first **normalizes** the
address: IPv4-mapped (`::ffff:a.b.c.d`, incl. the hex form `::ffff:a9fe:a9fe`) and
IPv4-compatible (`::a.b.c.d`) IPv6 become the embedded IPv4; NAT64 (`64:ff9b::/96`,
`64:ff9b:1::/48`) and 6to4 (`2002::/16`) are treated as their embedded IPv4 for deny checks.

Then, before any allow rule, these are **always refused**, whatever the env says:
`0.0.0.0/8`, `::/128`, `169.254.0.0/16`, `fe80::/10` (link-local, incl. cloud metadata
endpoints), `224.0.0.0/3` (multicast, reserved, broadcast), `ff00::/8`. A configured CIDR that
overlaps any of them (after normalization, so `::ffff:0:0/96` counts as `0.0.0.0/0`) stops the
engine at startup. Translation ranges themselves (`64:ff9b::/96`, `2002::/16`, `::ffff:0:0/96`)
cannot be listed.

### 4.2 `EGRESS_PRIVATE_CIDRS`

Comma-separated CIDR ranges (`10.20.0.0/16,192.168.5.0/24,fd12:3456::/48`). After §4.1, an
address inside a listed range passes the private-address check; everything else in §11.4 still
applies:

- the host must still pass `EGRESS_ALLOWLIST` (or the purpose-scoped allowance of §5.3). An IP
  literal may be an allowlist entry only if it falls inside a listed range;
- DNS pinning stays: the engine resolves, filters every answer, and connects only to an accepted
  address. A name resolving to listed and unlisted private addresses connects only to listed
  ones; none accepted → `EGRESS_PRIVATE_IP` as today;
- loopback (`127.0.0.0/8`, `::1`) passes only when listed explicitly — for a sidecar model server.

A malformed CIDR stops the engine at startup. `engine_listening` logs the ranges.

### 4.3 Ports in `EGRESS_ALLOWLIST`

An allowlist entry may now carry a port: `llm.corp.internal:8000`, `.svc.corp:443`. With a port,
only that port matches; without one, any port matches (today's behavior, unchanged). The
documentation recommends ports for every entry that resolves into `EGRESS_PRIVATE_CIDRS`.

### 4.4 `EGRESS_HTTP_HOSTS`

Entries in allowlist syntax (exact / `.suffix`, optional port) that may be reached over plain
`http:`. The target must also pass `EGRESS_ALLOWLIST` or §5.3. Applies to every egress purpose.
Everything else stays HTTPS-only.

Plain HTTP sends `Authorization`, `X-Engine-Secret` and payloads in clear: `engine_listening`
lists the entries, and the first request per host per process logs `egress_plaintext` (warn,
`host`, `purpose`). `ALLOW_INSECURE_EGRESS=1` keeps its meaning (`http://localhost` for
development) and is documented as dev-only.

### 4.5 `EGRESS_PUBLIC_PROVIDERS`

Default `1` — built-in provider hosts and the GigaChat OAuth host are allowed, as today. `0` —
they are not. Every `llm` entry (including each entry of a §9.5 chain) whose model or credential
destination would be a built-in public host is refused at validation with `400 egress_denied`
(`target: "llm.<index>"`, `host`), instead of hanging on DNS until the run times out.

### 4.6 Provider proxies

`<PROVIDER>_PROXY_URL` stays as is for built-in destinations. A proxy sees no DNS answer, so it
cannot honor §4.1–§4.2. Therefore a proxy together with a base URL override (§5.1) for the same
provider is a **startup error**, and endpoints (§5.2) have no proxy. (A trusted egress proxy for
internal destinations is a later candidate, §10.)

### 4.7 Internal CA

No code change. Documented recipe: `NODE_EXTRA_CA_CERTS` points to one PEM bundle (in the image
it defaults to the system bundle with `certs/` baked in); to trust a corporate CA, mount a bundle
that contains it and point `NODE_EXTRA_CA_CERTS` at it, or build a derived image with the CA
copied into `certs/`. `rejectUnauthorized: false` remains forbidden.

## 5. Part B — Self-hosted and gateway models

### 5.1 Base URL overrides for named providers

`<PROVIDER>_BASE_URL` for every named provider (`ANTHROPIC_`, `OPENAI_`, `DEEPSEEK_`, `GLM_`,
`GIGACHAT_`, `MINIMAX_`, `KIMI_`). Use: an on-prem installation of the same API, or a corporate
gateway that speaks it.

- Set by the operator, so it is trusted like a built-in URL: the provider's env key is used with
  it. It is **not** exempt from §4.1–§4.4.
- Validated at startup (URL, scheme, §4.6 conflict); invalid → the engine does not start.
- Everything else about the provider (dialect, capabilities, caps, window profiles, thinking
  mapping, signatures) stays as built in. `llm.base_url` from the request remains forbidden for
  named providers.
- `engine_listening` logs overridden providers with scheme and `host:port`.

**GigaChat** has two destinations: the API and OAuth. `GIGACHAT_OAUTH_URL` overrides the second.
Setting exactly one of `GIGACHAT_BASE_URL` / `GIGACHAT_OAUTH_URL` is a startup error. The OAuth
token cache and single-flight map are keyed by OAuth URL + key + scope (today key + scope), and
`401` invalidation uses the same key.

### 5.2 Model endpoints

An endpoint is an operator-defined model server with a name. Defined by env with the prefix
`LLM_ENDPOINT_<NAME>_` (`<NAME>`: `[A-Z0-9_]+`; in requests it is lowercased with `_` → `-`, so
`LLM_ENDPOINT_VLLM_MAIN_URL` is `vllm-main`; two env names mapping to one request name → startup
error):

| Variable | Required | Meaning |
|---|---|---|
| `_URL` | yes | base URL (`…/v1`) |
| `_KIND` | no | `openai` (default) or `anthropic` — the wire dialect |
| `_API_KEY` | no | key; absent → no authentication header at all (§5.4) |
| `_CONTEXT_WINDOW` | no | tokens; default `MAX_CONTEXT_FALLBACK` |
| `_MAX_TOKENS` | no | cap for `limits.max_tokens`; default 32 000 |
| `_PARALLEL_TOOLS` | no | `0`/`1`; default `0` |
| `_USAGE_IN_STREAM` | no | `0`/`1`; default `0` (usage estimated, §8.2) |
| `_TOOL_CHOICE_NONE` | no | `0`/`1` — honors `tool_choice: none`; default `1` |
| `_THINKING` | no | how `params.thinking` is sent: `off` (never; `llm_param_unsupported` warn), `effort` (OpenAI `reasoning_effort`; default for `openai`), `budget` (Anthropic `thinking.budget_tokens`; default for `anthropic`), `adaptive` (Anthropic adaptive + effort) |
| `_REASONING` | no | `anthropic` kind only: `signed` (default — signatures preserved and replayed unchanged, like Anthropic) or `unsigned` (closed blocks stored with an empty signature and replayed, like Kimi) |
| `_REASONING_REPLAY` | no | `openai` kind only: how stored reasoning goes back to the server on the next step — `none` (default: stored in history, not sent; local chat templates drop past thinking anyway), `reasoning` (the field current Ollama and vLLM read), `reasoning_content` (older vLLM / DeepSeek-style servers) |
| `_PREFIX_BINDING` | no | `0`/`1`, see below; default `0` |
| `_MAX_CONCURRENCY` | no | provider queue ceiling (§11.6); default `PROVIDER_MAX_CONCURRENCY_DEFAULT` |
| `_CONCURRENCY_SCOPE` | no | `endpoint` (default — one queue for the server whatever key a request carries; a local server's capacity is per server) or `key` (one queue per key, as for named providers — for a gateway with per-key limits) |

Request:

```json
"llm": { "provider": "endpoint", "endpoint": "vllm-main", "model": "qwen3-235b-a22b" }
```

- New `llm.provider` value `endpoint` and field `llm.endpoint` (required with it, forbidden
  otherwise). Unknown name → `400 bad_request` listing known names.
- `llm.base_url` is forbidden with `endpoint`. `llm.api_key` is allowed and overrides
  `_API_KEY` (per-tenant keys on a shared gateway). `llm.capabilities` and
  `llm.context_window_tokens` from the request win over the endpoint's values, as for any provider.
- **Identity, three separate things:**
  - *public reference* — `{ provider: "endpoint", endpoint: "<name>" }`, everywhere the engine
    names a model entry: `usage.calls[]`, `llm_used`, `llm_fallbacks[]`, SSE `llm_fallback`
    `from` / `to`, callback, journal events (`provider`, `endpoint` fields). Named providers keep
    their shape (no `endpoint` field);
  - *SDK namespace* — `anthropic` for the `anthropic` kind (the adapter only reads that key),
    the endpoint name for the `openai` kind;
  - *reasoning owner* — `reasoning.provider` = `endpoint:<name>`: a signature from one endpoint
    is replayed only to the same endpoint, never to another or to a named provider (§5.2 of the
    SPEC, generalized from the MiniMax / Kimi rule).
- Prefix binding (`drop_block`, §9.3): `_PREFIX_BINDING=1` (`anthropic` kind with `signed`
  only) turns on the existing edit detector and `drop_block` for the endpoint, as for Claude
  models that bind thinking to the prefix — for a gateway in front of such models. Default `0`:
  never assumed for an unknown implementation.
- Provider queue key (§11.6): `endpoint:<name>`, plus the hash of URL and key with
  `_CONCURRENCY_SCOPE=key`; this string is internal
  (queue, metrics label, `/health`), never a public provider value.
- Cost: through `llm.pricing`, as for any provider.
- Fallback chains (§9.5) may mix endpoints and named providers.
- `engine_listening` logs endpoint names, kinds and `host:port`; never keys.
- A malformed definition (missing `_URL`, bad enum, non-numeric number) stops the engine.

Endpoints cover common local servers (vLLM, Ollama, TGI, llama.cpp server, LM Studio, LiteLLM)
without a provider per product. Their tool-calling quirks (e.g. vLLM's
`--enable-auto-tool-choice`) are documented, not special-cased.

`openai-compatible` with `llm.base_url` from the request is unchanged (key still mandatory).

### 5.3 Scope of the automatic allowance

An override (§5.1) or endpoint (§5.2) URL is allowed **only** for the `provider` purpose and only
for its exact origin (scheme, host, port; and the OAuth origin for GigaChat). It does not open that
host for tools, the callback, images or the webhook: those still need `EGRESS_ALLOWLIST`. The
existing global `allowHost` is replaced by a purpose- and origin-scoped allowance.

### 5.4 Keyless means no credential

With no key (endpoint without `_API_KEY` and no `llm.api_key`), the request carries **no**
`Authorization`, `x-api-key` or other auth header. The engine never lets an SDK fall back to its
own env (`@ai-sdk/anthropic` reads `ANTHROPIC_API_KEY` when `apiKey` is omitted): the factory
always passes an explicit value and the provider fetch wrapper strips auth headers for keyless
endpoints. Test: both kinds, keyless, with every named-provider env key set — the mock server
sees no credential.

### 5.5 Local models out of the box (Ollama first)

Endpoints are the mechanism; this section makes local models a supported, tested path rather
than "should work". Reference servers, in order: **Ollama** (the first one: easiest to stand up,
pulls models from a file mirror, runs on CPU or one GPU) and **vLLM** (the recommended one for
production load: batching, real concurrency, tool parsers).

- **Recipe** in the on-prem guide: `deploy/docker-compose.yml` ships an `ollama` service next to
  the engine (internal network only, model volume, no published port) and the endpoint wired as
  `LLM_ENDPOINT_LOCAL_URL=http://ollama:11434/v1` with `EGRESS_HTTP_HOSTS=ollama:11434`,
  `EGRESS_ALLOWLIST=ollama:11434`, `EGRESS_PRIVATE_CIDRS=<compose subnet>`. Air-gapped model
  delivery is documented: pull on a connected machine, copy the Ollama models directory (or a
  GGUF + Modelfile), load offline. A vLLM variant of the same compose file is documented.
- **The context window trap.** A local server's context is whatever it was started with (Ollama
  picks a default by version and available memory, often far below the model's maximum), and a
  longer prompt is cut **silently**: Ollama keeps the system message and drops the oldest history,
  so the model loses earlier turns and tool results without any error. The recipe sets the server
  context explicitly (`OLLAMA_CONTEXT_LENGTH` or `num_ctx`; vLLM `--max-model-len`) and
  `LLM_ENDPOINT_<NAME>_CONTEXT_WINDOW` **below** it with headroom (recommended 80 %), because the
  engine's estimate is character-based, not the model's tokenizer: matching values reduce the
  risk, they do not remove it. `engine_listening` warns `endpoint_context_default` when an
  endpoint has no `_CONTEXT_WINDOW`; `smoke:local` checks the loaded context and runs an
  oversized history to confirm the engine trims (`context_trimmed`) before the server does.
- **Recommended models** — open-weight models with native tool calling in the chosen server
  (e.g. the Qwen3 and Llama 3.x instruct families, GPT-OSS); the list in the guide is a dated
  snapshot, not a contract. Models without tool calling work only with `tools: []`.
- **Wire quirks covered by tests**, using recorded fixtures of Ollama's and vLLM's
  OpenAI-compatible streams (no live server in CI): a tool call arriving whole in one chunk
  rather than as argument deltas; `usage` present / absent in the final chunk; reasoning deltas
  in `reasoning` and in `reasoning_content` (both stored as `reasoning`); `tool_choice: none`
  ignored (→ `_TOOL_CHOICE_NONE=0` path); several tool calls in one turn with
  `_PARALLEL_TOOLS=1`. Fixtures assert the **second outgoing request** too: assistant tool calls,
  tool results and reasoning serialized per `_REASONING_REPLAY` (the SDK only writes
  `reasoning_content`; `reasoning` and `none` need an endpoint-scoped request rewrite).
- **Reasoning must be structured.** The engine does not parse inline `<think>…</think>` out of
  answer text: text is streamed to SSE as it arrives, so it cannot be hidden afterwards, and an
  answer may legitimately contain the tag. The recipe turns on the server's reasoning output
  (Ollama `think`, vLLM `--reasoning-parser`); without it, thinking shows up as answer text. An
  inline-tag parsing mode is a later candidate (§10).
- **Live smoke** (not in CI, like §13 suite 7): `npm run smoke:local` against
  `SMOKE_LOCAL_URL` / `SMOKE_LOCAL_MODEL` — a run with a tool call, a second step consuming the
  result, a cancel mid-stream, usage present or estimated.
- **Queue defaults.** A single-GPU Ollama serves few streams at once; the recipe sets
  `_MAX_CONCURRENCY` to the server's parallelism (`OLLAMA_NUM_PARALLEL`) with the default
  `_CONCURRENCY_SCOPE=endpoint`, so excess runs wait in the engine queue (§11.6) instead of
  timing out inside the server, whatever keys requests carry. Test: simultaneous runs with
  different `llm.api_key` values share one ceiling.

## 6. Part C — Content-free logging

### 6.1 Sinks and the field registry

Sinks: stdout (pino, including the access log), the memory journal, the disk journal, the error
webhook body. Everything written to a sink goes through one sanitizer that consults a **field
registry**: for every event, every field path it may carry, and what that field is:

- **safe** — engine-produced values: ids the engine issued (`run_id`, `seq`, `boot_id`, run and
  call tokens never — they stay unlogged), codes, statuses, counts, sizes, durations, token
  numbers, levels, enum values, booleans;
- **external identifier** — ids that come from a provider or a caller rather than the engine:
  `call_id` (copied from the provider's tool call id, or posted to `tool-result`),
  `provider_request_id`. In strict mode (§6.3) `call_id` is replaced in records by an
  engine-issued `call_ref` (`s<step>c<index>`, unique within the run; `tool-result` posts for an
  unknown call log `call_ref: "unknown"`), and `provider_request_id` is dropped. The request /
  result path keeps the real ids;
- **declared identifier** — values the harness declared in the request: `session_id`,
  `idempotency_key`, `meta` keys, model names, `llm.endpoint`, names of tools and skills **as
  declared in the request**. The harness obligation (new Appendix A row) is to never put content
  into identifiers; under that obligation they are safe;
- a **content class** (§6.2).

A string not in the registry is dropped in strict mode (§6.3) and fails the test suite (§6.7).
The registry is code, reviewed with every new event.

### 6.2 Content classes

| Class | Fields (current names) |
|---|---|
| `prompt` | `run_start.content.system`, `system_sha256`, `prompt_blob` lines |
| `messages` | `history_tail` (message text constituents), `step_done.content.text` / `reasoning`, `run_done.content.answer`, `provider_failure.content.partial_text`, `interim_block_dropped.content.text`, `output_check.content.block` / `draft` / `issues`, `step_start.content.engine_note` |
| `tools` | tool args and results everywhere (`tool_call`, `tool_result`, `tool_call_repeated`, `tool_call_rejected`, `duplicate_write_intent`, `presentation_limit`, `step_done.content.tool_calls[].args`, the tool constituents of `history_tail`), `tool_http.content.body`, `tool_result_received.content`, `tool_protocol_error.content.body`, `tool_search.content.query`, `skill_unknown.content.name` |
| `model_names` | names the **model** produced that are not declared: an unknown tool name in `step_done.tool_calls` / `tool_call_rejected.tool`, an unknown skill; instance paths in `output_check.errors` (they can carry object keys from model output; schema keyword and schema path stay safe) |
| `external` | text whose origin is outside the engine: `provider_failure.content.provider_body`, `run_done.content.provider_body`, provider-originated `message` in `provider_failure` and `run_done.error_message`, network / TLS error text, image fetch errors, callback receiver responses (`callback_attempt_failed.error`, `callback_failed.error`, webhook `callback.last_error`), `error_webhook_failed.err`, `gigachat_files_deleted.errors[]`, exception messages, names and stacks (`run_crashed`, `run_failed`, `unhandled_error`, `journal_write_failed`) |
| `meta` | values of `meta` (keys are declared identifiers; `session_id` is a declared identifier) |
| `urls` | URL paths and fragments in `run_start.callback`, `tool_call.endpoint`, `callback_sent.url`, `egress_*`, webhook `callback.url`; scheme, host and port are safe, query values are already scrubbed |

**URL credentials are secrets, not content.** Userinfo (`user:password@`) is refused in every
egress URL (`400 egress_denied` at validation; startup error in `_BASE_URL`, `_OAUTH_URL`,
`LLM_ENDPOINT_*_URL`, `ERROR_WEBHOOK_URL`) — the fetch would reject it anyway — and is redacted
unconditionally at every sink, in every mode including `all`.

Composite fields are filtered **by constituent before formatting**: `history_tail` is built from
messages with each part filtered by its class (a tool-call part by `tools`, a text part by
`messages`); `step_done.content.tool_calls[]` keeps declared `name` and filters `args` by
`tools` and provider diagnostics by `external`.

### 6.3 `LOG_CONTENT`

`LOG_CONTENT` = `all` (default — today's behavior) | `none` | a comma list of classes to keep
(`LOG_CONTENT=prompt,tools`). An excluded class:

- never reaches any sink — neither the value nor anything derived from it (hash, prefix); lengths
  and counts are safe and stay;
- is replaced where the shape needs a value: a string becomes `"[omitted]"`; `meta` keeps its keys
  with `"[omitted]"` values; a URL becomes its origin; an excluded `external` message becomes the
  engine's own localized text for the error `code` (Appendix B), with `code`, `provider_status`,
  `retriable` kept; an exception becomes its `code` (engine errors) or `"Error"`, and `stack` is
  **omitted**. A stack is a string the message is part of, and a message can forge frame-shaped
  lines, so no parsing of it is trusted. Custom exception names are `external`. Operators who
  need stacks keep `external` in `LOG_CONTENT`.

**Strict mode** is any value other than `all`: the registry is enforced (unregistered strings
dropped). With `all`, output is today's, except that URL userinfo is always redacted (above).

`LOG_PROMPTS=1` (stdout) obeys the same classes.

### 6.4 Per-request ceiling and the logging context

New optional request field:

```json
"logging": { "content": "none" }          // or a list of classes: ["tools"]
```

It can only **narrow** env: effective classes = env ∩ request. Use: one engine, a harness with
some tenants under stricter rules.

- **Logging context.** `POST /runs` reads `logging` right after JSON parsing, before semantic
  validation, and creates an immutable context `{ classes }`. Every event emitted for that request
  — validation warnings, `run_rejected`, run events, the callback job, alerts, GigaChat cleanup,
  events after registry deletion (`ack_missing`) — carries this context explicitly (stored on the
  run record and the delivery job; the implementation may use `AsyncLocalStorage` inside the
  request). Alerts go through the same sanitizer as log events.
- An event with no context (body not parseable, `logging` itself invalid, process-level events)
  is sanitized as `none`.
- `run_rejected` keeps `http_status` and `code`; its `message` and `details` are engine text
  (zod / validation) and are sanitized as `external` — validator messages can quote input.
- `run_start` logs `content_classes` (safe).

### 6.5 What does not change

This RFC covers the engine's **own records**. The request path is the contract and is unchanged:
`GET /runs/{id}` returns full `messages` to the harness, SSE streams text, the callback carries the
result, in-memory run state lives until retention (§11.5). An operator who must keep content out
of engine memory beyond the run sets short retention (`RUN_RETENTION_MS`,
`RUN_RETENTION_UNACKED_MS`); documented, not new.

Switching `LOG_CONTENT` does not rewrite existing disk files. `engine_listening` logs
`content_classes`; the operator purges `LOG_DIR` if older files must go. `GET /logs` reports
`buffer.content_classes`; the boolean `buffer.content` stays as `content_classes` non-empty.

### 6.6 Default stays `all`

Defaults are unchanged for 1.x (semver: no breaking changes). The on-prem guide recommends
`LOG_CONTENT=none` and the deploy templates (§7.4) set it.

### 6.7 Canary conformance test

The definition of "done" for Part C. A canary string is placed in: `system`; every history role;
`meta` values; tool args; sync, async and error tool results; a tool endpoint path; a callback URL
path and a callback receiver's error response; a provider error body and provider `message`; a
TLS / network error message; an image URL path and an image fetch failure; model output (text,
reasoning, tool call args, an **undeclared tool name**, an undeclared skill name, an
`output_checks` block with the canary as an object key); a `search_tools` query; an exception
message raised inside the loop; a `POST /runs` body rejected by validation. With `LOG_CONTENT=none`
(env), and separately with `logging.content: "none"` (request) on a `LOG_CONTENT=all` engine,
across the §13 scenarios, the canary must not appear in captured stdout (incl. the access log),
the memory journal, the disk journal files or captured webhook bodies. Per-class variants check
that each class drops exactly its fields. Concurrent runs with different ceilings must not leak
into each other's events. A registry check fails the build when an event emits a field path the
registry does not list.

### 6.8 Compatibility of `LOG_BUFFER_CONTENT`

`LOG_BUFFER_CONTENT=0` becomes an alias of `LOG_CONTENT=none`. This is the one tightening in the
RFC: the old switch left external text, URLs, model-invented names and webhook `meta`; the alias
removes them. It only ever removes data from logs. `LOG_BUFFER_CONTENT=0` with `LOG_CONTENT` set to
anything but `none` → startup error.

## 7. Part D — Air-gapped delivery

### 7.1 Release artifacts

On every version tag, besides the GHCR image, the GitHub Release carries:

| File | What |
|---|---|
| `theloop-<v>-image-linux-amd64.tar`, `…-arm64.tar` | `docker save` of the image; `docker load` / `podman load` / `ctr import` |
| `theloop-<v>-node.tar.gz` | `dist/`, production `node_modules`, `package.json`, `certs/`, `LICENSE`, `NOTICE`; runs with `node dist/index.js` on Node ≥ 22.9 |
| `theloop-<v>-sbom.cdx.json` | CycloneDX SBOM of the production dependency tree |
| `THIRD_PARTY_LICENSES.txt` | licenses of every bundled package |
| `SHA256SUMS`, `SHA256SUMS.sig` | checksums of all files; signature verifiable offline with the public key in the repo (`cosign verify-blob --key theloop.pub`) |

The Node bundle is platform-independent: production dependencies are pure JavaScript, and the
release job fails if the production tree contains a native addon (`*.node`) or an install script.
Supported targets: Linux x64 / arm64 with Node ≥ 22.9 (CI runs the bundle's smoke test on both).
CA material: `certs/` is in the bundle; the operator sets `NODE_EXTRA_CA_CERTS` to a PEM bundle
(documented, with the one-liner that builds it from `certs/` and a corporate CA).

The README gets an "Offline install" section: verify, load, run.

### 7.2 Image

- Runs as non-root (`USER node`, uid 1000); works under an arbitrary uid with gid 0 (OpenShift):
  `/app` is group-readable, `LOG_DIR` must be a writable volume.
- Works with a read-only root filesystem: the engine writes nothing outside `LOG_DIR`.
- `ARG BASE_IMAGE=node:22-slim`: a derived build on a customer base image is one build arg.
- `HEALTHCHECK` with `node -e` against `http://127.0.0.1:$PORT/health` (no curl in slim).

### 7.3 No outbound connection on its own

Property, tested: the engine opens a network connection or resolves a name only for (a) a URL from
a request, (b) a provider / endpoint for a run, (c) the callback, (d) `ERROR_WEBHOOK_URL`. Never at
startup, never on a timer. Test: start the engine with a DNS resolver and dispatcher that record
and fail every call, serve `/health`, `/metrics`, `GET /logs`, a run against a mock model; assert
zero lookups and connections outside (a)–(d).

### 7.4 Deploy templates

`deploy/docker-compose.yml` and `deploy/kubernetes/` (Deployment with HTTP probes on `/health` and
`securityContext` — non-root, read-only rootfs, no privilege escalation, dropped capabilities;
Service; Secret mounted as files; PVC for `LOG_DIR`; `LOG_CONTENT=none`). Examples, not a
supported Helm chart.

## 8. Part E — Operations without SaaS

### 8.1 Secrets from files

Every secret env variable accepts a `_FILE` twin: `ENGINE_TOKEN_FILE`, `CALLBACK_SECRET_FILE`,
`<PROVIDER>_API_KEY_FILE`, `GIGACHAT_AUTH_KEY_FILE`, `<PROVIDER>_PROXY_URL_FILE`,
`LLM_ENDPOINT_<NAME>_API_KEY_FILE`, `METRICS_TOKEN_FILE`. Read once at startup, one trailing
newline trimmed. Both the variable and its `_FILE` set → startup error; unreadable or empty file →
startup error (path in the message, never the content).

### 8.2 `GET /metrics`

Prometheus text format. Auth: `METRICS_TOKEN` (Bearer); unset → `/metrics` answers `404`.
`ENGINE_TOKEN` is not accepted there: a scraper must not hold the harness credential.

| Metric | Type | Labels |
|---|---|---|
| `theloop_runs_started_total` | counter | — |
| `theloop_runs_finished_total` | counter | `status`, `finish_reason` |
| `theloop_runs_active`, `theloop_runs_retained` | gauge | — |
| `theloop_provider_attempts_total` | counter | `provider`, `model`, `outcome` (`ok`/`failed`/`unknown`), `status_class` (`2xx`/`4xx`/`429`/`5xx`/`network`) |
| `theloop_provider_attempt_duration_seconds` | histogram | `provider`, `model` |
| `theloop_provider_ttft_seconds` | histogram | `provider`, `model` |
| `theloop_tokens_total` | counter | `provider`, `model`, `kind` (`input`/`output`/`cache_read`/`cache_write`) |
| `theloop_provider_queue_active`, `theloop_provider_queue_depth` | gauge | `provider` (summed over keys) |
| `theloop_provider_queue_wait_seconds` | histogram | `provider` |
| `theloop_llm_fallbacks_total` | counter | `from_provider`, `to_provider` |
| `theloop_tool_calls_total` | counter | `outcome` |
| `theloop_tool_call_duration_seconds` | histogram | — |
| `theloop_callback_deliveries_total` | counter | `outcome` (`sent`/`failed`) |
| `theloop_egress_denied_total` | counter | `purpose` (`tool`/`callback`/`image`/`provider`/`error_webhook`), `reason` (`not_allowlisted`/`private_ip`/`scheme`/`userinfo`/`invalid_url`) |
| `theloop_journal_bytes`, `theloop_journal_dropped_total` | gauge / counter | `store` (`memory`/`disk`) |

Label cardinality is bounded by construction: `provider` is a named provider id or
`endpoint:<name>` (operator-defined set) or `openai-compatible`; no key hashes, no `meta`,
session, run, tenant or tool-name labels; internal purpose strings like `tool:<name>` are
normalized to the finite `purpose` enum. `model` is request-controlled: the first
`METRICS_MAX_MODELS` (default 50) distinct values get their own label, the rest are `other`.
Counters reset on restart. Per-key queue detail stays in `/health` (as today).

### 8.3 `/health` detail

`HEALTH_DETAILS=0` → an unauthenticated `/health` answers `{ "ok": true, "shutting_down": false }`
only — no version, counters or `provider_throttle` — for installations whose scanners flag
unauthenticated version disclosure. With `Authorization: Bearer <ENGINE_TOKEN>` it returns the
full body as today. Default `1` (unchanged).

## 9. SPEC changes

- §4.2: `logging`; `llm.provider: "endpoint"`, `llm.endpoint`.
- §4.7: `HEALTH_DETAILS`. New §4.10: `GET /metrics`.
- §4.9: `buffer.content_classes`.
- §5.2: reasoning owner `endpoint:<name>`; `_REASONING`.
- §7, §8, §9.5: the endpoint public reference in `usage.calls[]`, `llm_used`, `llm_fallbacks[]`,
  SSE `llm_fallback`.
- §9.1: base URL overrides, GigaChat OAuth override, endpoints, keyless, `EGRESS_PUBLIC_PROVIDERS`.
- §11.4: normalization, unconditional denies, `EGRESS_PRIVATE_CIDRS`, ports in
  `EGRESS_ALLOWLIST`, `EGRESS_HTTP_HOSTS`, purpose-scoped allowance, proxy + override conflict,
  internal CA.
- §11.6: endpoint queue key, `_MAX_CONCURRENCY`.
- §12.2–§12.4: the field registry, content classes, `LOG_CONTENT`, the logging context, strict
  mode; new event `egress_plaintext`; `engine_listening` gains `private_cidrs`, `http_hosts`,
  `provider_overrides`, `endpoints`, `content_classes`.
- §13: suites for A (normalization incl. hex-mapped and NAT64 forms, deny-overlap startup errors,
  mixed DNS answers, IP-literal entries, ports, plain HTTP only for listed entries, public
  providers off incl. chains, proxy + override conflict), B (override with env key, GigaChat pair
  rule and cache key, endpoint parsing and name collisions, keyless with all env keys set,
  signed / unsigned endpoints across runs and fallback, `_PREFIX_BINDING` with trimming and date changes, public reference everywhere, purpose
  scoping), C (§6.7, plus canaries in provider tool-call ids, `provider_request_id`, an unknown `tool-result` call id, a multiline exception message and one with a forged frame line, URL userinfo), D (§7.3, native-addon check), E (`_FILE` resolution and conflicts, metrics
  auth and cardinality incl. many distinct tool names, `HEALTH_DETAILS`).
- §14: new env block; offline install; non-root and read-only rootfs.
- §15: TLS listener, mTLS, journal encryption at rest, erasure by session, HMAC-pseudonymized
  `meta`, internal egress proxy, OpenTelemetry, Helm chart.
- Appendix A: new row — identifiers (`session_id`, `idempotency_key`, `meta` keys, tool / skill /
  model names, endpoint names) never carry content; they are logged in every mode.

## 10. Later candidates (not in v1.5.0)

- **TLS listener** and **mTLS** (harness → engine; engine → tools / endpoints), with TLS-aware
  probes and healthchecks.
- **Inline `<think>` parsing** for endpoints whose server cannot emit structured reasoning
  (before SSE, split delimiters, cancellation, literal-tag answers).
- **Internal egress proxy** for tools / callback / endpoints, with an explicit trust model.
- **Erasure by session** — `DELETE /logs?session_id=` rewriting day files.
- **Pseudonymized `meta`** — `LOG_META_HMAC_KEY`: values logged as keyed hashes.
- **OpenTelemetry traces**; a supported Helm chart.

## 11. Delivery plan

Independent PRs, in this order (each with its SPEC section and tests):

1. Part C — field registry, content classes, `LOG_CONTENT`, logging context, canary suite.
2. Part A — normalization, CIDRs, ports, HTTP hosts, public providers switch, proxy conflict.
3. Part B — overrides (incl. GigaChat pair), endpoints, purpose-scoped allowance, keyless;
   local models (§5.5): fixtures, compose recipe with Ollama, `smoke:local`.
4. Part E — `_FILE` secrets, `/metrics`, `HEALTH_DETAILS`.
5. Part D — image hardening, release artifacts, deploy templates, §7.3 test.

v1.5.0 is tagged when all five are merged. Release notes and the site changelog per the usual
release checklist.

## 12. Implementation notes

Where v1.5.0 differs from the text above; the SPEC describes what shipped.

- Strict mode replaces an excluded `external` message and an exception message with `"[omitted]"`
  (not a localized engine text); `code`, `provider_status`, `retriable` stay.
- External call ids become `c1`, `c2`, … in the order a run's records first see them (not
  `s<step>c<index>`).
- An event with no run context uses `LOG_CONTENT`; only a request whose `logging` is present but
  invalid falls back to `none` for its refusal.
- The engine trims middle turns only (SPEC §5.1): the first user message and the last four are
  kept, so one oversized message can still exceed a local server's context. Documented in §9.6.
- The signature of `SHA256SUMS` is produced when the repository has a `COSIGN_PRIVATE_KEY` secret;
  without it the release carries unsigned checksums.
- The TLS listener stays out of scope (§10); metrics also carry `theloop_tool_call_duration_seconds`
  and journal size.
