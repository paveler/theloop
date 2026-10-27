# RFC 0001: Skills and deferred tools

| | |
|---|---|
| Status | Accepted 2026-10-27. PR A (v1.3.0: `skills[]`, `defer_loading`, `load_skill`) implemented; PR B (`search_tools`) next. Review history: draft 2026-10-27; revised the same day after review: activating pairs pinned against trimming (5.7), name reservation gated on the feature (4.4), `tool_not_loaded` excluded from repeat detection (5.5), model text in journal `content` (9), v1.3.0 check for deferred tools outside skills (4.4); second pass: `builtin: true` marker on engine-written tool messages and `tool_calls[]` entries, the only thing that distinguishes a built-in pair from a legacy HTTP tool of the same name (4.5, 5.7) |
| Scope | Additive to `contract_version: "1"`; a request without `skills[]` and `defer_loading` behaves exactly as today |
| Target | v1.3.0: `skills[]`, `tools[].defer_loading`, built-in `load_skill`. v1.4.0: built-in `search_tools` |
| Prerequisite | AI SDK v6 line: `ai` 6.x, `@ai-sdk/anthropic` 3.x, `@ai-sdk/openai-compatible` 2.x (see section 14) |
| Supersedes | ROADMAP 2.2 "Skills on demand" |

## 1. Summary

Today the model sees every tool in `tools[]` from step 1, and the prompt is whatever `system`
carries. The harness builds the request once per turn, so it can only choose per turn. This RFC
lets the model pull instructions and tools **within a run**, between steps:

- **`skills[]`**: named instruction bundles (the body of a `SKILL.md`) with the tools they
  unlock. The engine appends an index (name + description) to `system` and offers a built-in
  tool **`load_skill`** that returns the body and activates the skill's tools.
- **`tools[].defer_loading: true`**: a tool the model does not see until it is activated, by a
  skill that lists it or by the built-in **`search_tools`** (BM25 over names, descriptions and
  argument names).
- Activation does not break the prompt cache. On Anthropic models with tool search the engine
  returns `tool_reference` blocks and the API expands the definitions inside the conversation,
  so the prefix is untouched. On every other provider the tools array of the next step grows:
  one prefix cache miss per activation, nothing else.
- The engine stays stateless. What is loaded is derived from the history on every run; the
  harness stores nothing new.

## 2. Motivation

Progressive disclosure of instructions and tools is now the common shape of agent runtimes.
The Agent Skills format (`SKILL.md`: a short description always in context, the body loaded on
demand) is implemented by several agent products and SDKs, and the Claude API ships tool search
with `defer_loading` and `tool_reference` as a GA feature; the OpenAI Responses API has the same
pair. The published numbers for deferred tools are a large cut in tool-definition tokens and a
measurable gain in tool selection accuracy once a catalog passes a few dozen tools.

ROADMAP 2.2 described skills but kept "all tools are still declared up front: adding tools
mid-run would reset the prompt cache". That no longer holds for Anthropic (`tool_reference`
expansion lives in the message body, not in the prefix), and on the other providers one cache
miss per activation is cheaper than carrying every tool on every turn. The design below also
keeps the §9.3 rule: the history is only appended to, and nothing that changes between turns
sits before it.

## 3. Terms

- **Deferred tool**: a `tools[]` entry with `defer_loading: true`. Not in the model's context
  until activated.
- **Visible tools**: the tools the model can call on a step: every non-deferred tool (built-ins
  included) plus the deferred tools activated so far.
- **Activation**: making a deferred tool visible from the next step on. Two mechanisms
  (section 5.6): `tool_reference` and `tools_array`.
- **Built-in tool**: a tool the engine implements itself, with no endpoint: `load_skill`,
  `search_tools`. The names are reserved.
- **Skill index**: the engine-written block at the end of `system` that lists the skills.

## 4. Contract changes (SPEC §4.2)

### 4.1 `skills[]`

```jsonc
"skills": [
  {
    "name": "order-returns",
    "description": "Return and refund policy, how to open a return. Use when the user asks about returning or refunding an order.",
    "body": "# Returns\n\nCheck the order status first ... (the SKILL.md body without frontmatter)",
    "tools": ["createReturn", "getReturnStatus"]
  }
]
```

| Field | Required | Constraints |
|---|---|---|
| `name` | yes | `^[a-z0-9][a-z0-9_-]{0,63}$`; unique within the request |
| `description` | yes | 1 to 1024 characters: what the skill covers and when to load it. This is all the model sees before loading |
| `body` | yes | 1 byte to 32 KiB (UTF-8); Markdown, returned verbatim by `load_skill` |
| `tools` | no | names from `tools[]`, default `[]`. Listing a non-deferred tool is allowed and changes nothing for that tool |

Up to **64** skills per request. The constants live in `contracts.ts` as `SKILL_LIMITS`. Skill
names and tool names are separate namespaces.

### 4.2 `tools[].defer_loading`

```jsonc
{ "name": "createReturn", "description": "...", "input_schema": { "...": "..." },
  "endpoint": "https://api.example.com/tools/createReturn", "effect": "write",
  "defer_loading": true }
```

Boolean, default `false`. A deferred tool is shown to the model only after activation
(section 5). It is still validated, egress-checked and executed like any other tool, and the
`effect` rules of §6.4 are unchanged. Deferral is a context optimisation, not an authorization
boundary.

### 4.3 Built-in tools

| Name | Offered when | Input | `effect` |
|---|---|---|---|
| `load_skill` | `skills[]` is non-empty | `{ "name": string }` | `read` |
| `search_tools` (v1.4.0) | at least one deferred tool is listed in no skill | `{ "query": string, "limit"?: integer 1 to 20 }` | `read` |

Built-ins have no endpoint, are never retried and never truncated by `tool_result_max_bytes`,
and **do not count toward `limits.max_tool_calls`**. Each one still takes a step like any tool
call: a skill costs one step, and harnesses set `max_steps` with that in mind. Their
descriptions and the skill index are engine text in the run locale (Appendix B).

### 4.4 Validation: `400 bad_request`

The checks below apply only to a request that **uses the feature**: `skills[]` non-empty, or at
least one tool with `defer_loading: true`. A request without either is validated exactly as
today, so a harness that happens to have an HTTP tool named `load_skill` or `search_tools`
(ROADMAP 2.2 suggested the first name) keeps working until it adopts skills; this is what keeps
the change additive.

| Condition | Message |
|---|---|
| the feature is used and a `tools[]` entry is named `load_skill` or `search_tools` | `tools[2].name "load_skill" is reserved when skills or deferred tools are used` |
| duplicate `skills[].name` | `skills[1].name "order-returns" is duplicated` |
| `skills[].tools` names a tool absent from `tools[]` | `skills[0].tools: unknown tool "createReturn"` |
| **v1.3.0 only, until `search_tools` ships:** a deferred tool listed in no skill | `tools[3] "exportReport" is deferred but listed in no skill` |
| name, description, body or count outside 4.1 | the zod message with its path, as for other fields |

Nothing else can be refused up front. "At least one non-deferred tool" always holds: a request
with deferred tools always carries `load_skill` or, from v1.4.0, `search_tools`. The fourth
check exists so that a release with `defer_loading` but without `search_tools` cannot accept a
tool that nothing can activate; v1.4.0 drops it, because such a tool then turns `search_tools`
on (4.3).

### 4.5 The `builtin` marker (SPEC §5, §7)

A `tool` message the engine writes for a built-in call carries `builtin: true`:

```json
{ "role": "tool", "call_id": "call_01...", "tool": "load_skill", "builtin": true,
  "is_error": false, "result": "# Returns\n..." }
```

Optional, literal `true`, absent on every HTTP tool message, like `partial` on assistant
messages. It is the only thing that makes a historical `load_skill` or `search_tools` pair a
built-in one (5.7): a shape check cannot tell an HTTP tool that returned Markdown from the
engine's own result. The matching `tool_calls[]` entry of the result (§7) carries
`builtin: true` as well, so a harness can keep built-ins out of its HTTP tool statistics without
matching names.

## 5. Loop semantics: new SPEC §6.8

### 5.1 The skill index in `system`

If `skills[]` is non-empty, the engine appends the index to `system` after a blank line
(`system` may be absent; the index is then the whole system text):

```
[engine] Skills. Before working on a topic a skill covers, call load_skill with its name: the instructions, and the tools the skill unlocks, arrive on the next step.
- order-returns: Return and refund policy, how to open a return. Use when the user asks about returning or refunding an order.
- shipping-rates: ...
```

Skills are listed **sorted by name**; the request order carries no meaning, as for tools. The
index is stable between turns, so it sits inside the cached `system` block (§9.3, point 2). The
engine never puts dates or anything turn-dependent there (§9.4).

### 5.2 Visible tools and the step

- Step 1: visible = non-deferred tools + built-ins + the tools restored from history
  (section 5.7). A tool listed in `skills[].tools` without `defer_loading` is visible anyway.
- A step's tool calls are executed; the activations they produce take effect **from the next
  step**.
- The context estimate (§5.1) counts `system` with the index and the **visible** tools only.
  Deferred tools that were not activated cost nothing in context on either mechanism.

### 5.3 `load_skill`

`{ "name": "order-returns" }`:

- Known skill: `ok`. The stored `result` is the **body as a string**, verbatim, in a `tool`
  message with `builtin: true` (4.5). What the model sees (provider boundary, Appendix B) is a
  header line, a blank line and the body:

  ```
  [engine] Skill "order-returns" loaded. Tools available from the next step: createReturn, getReturnStatus.

  # Returns
  ...
  ```

  For a skill with no deferred tools the header is `[engine] Skill "order-returns" loaded.`
  Every deferred tool in the skill's `tools` becomes visible from the next step (section 5.6).
- Unknown skill: tool error `unknown_skill: order-refunds. Available skills: order-returns,
  shipping-rates.`; `tool_calls[].status = error`; the loop continues.
- The same skill a second time **in the same run**: §6.7 `repeated_call`, as for any tool.
- A skill already loaded in an **earlier run** (restored from history, section 5.7): `ok` with
  the body again; history calls are not repeats (§6.7, rule 1). The journal marks it
  `reloaded: true`.
- Several `load_skill` calls in one step run in call order, like any batch (§6.3).

### 5.4 `search_tools`

`{ "query": "refund an order", "limit": 5 }`:

- The engine ranks **every deferred tool** with BM25 (`k1 = 1.2`, `b = 0.75`) over a document
  built from the tool's `name` (split on `_`, `-` and camelCase), its `description`, and the
  property names and `description`s of `input_schema`. Tokens are lower-cased runs of Unicode
  letters and digits of at least two characters; no stemming, no stop words, so the search is
  language-neutral. A query over 500 characters is cut to 500. Only tools with a positive score
  are returned, best first, ties broken by name, at most `limit` (default 5, cap 20).
- The stored `result` is JSON, provider-neutral, in a `tool` message with `builtin: true` (4.5):

  ```json
  { "tools": ["createReturn", "getReturnStatus"], "in_skills": { "cancelOrder": "order-cancel" } }
  ```

  `tools`: matches listed in no skill; they are activated from the next step. `in_skills`:
  matches that belong to a skill; they are **not** activated, the model is pointed to the skill
  so the tool arrives together with its instructions.
- What the model sees (Appendix B):

  ```
  [engine] Tools available from the next step: createReturn, getReturnStatus.
  Part of skills, load the skill first: cancelOrder (order-cancel).
  ```

  No match: `[engine] No tools match "refund an order". Try other words for what the tool should
  do.` This is a text result, not an empty one in the §6.2 sense, so §6.7 rule 4 does not fire;
  `max_steps` bounds a model that keeps searching.
- The exact same query again in the same run: §6.7 `repeated_call`.

### 5.5 A call to a deferred tool that is not visible

The model can only know such a name from the skill index or from older history (a run where the
tool was visible). The call is **not executed**, because the model has never seen the schema,
and gets a tool error as a §6.1 rejection:

- listed in a skill: `tool_not_loaded: createReturn belongs to skill "order-returns". Call
  load_skill("order-returns") first.`
- in no skill: `tool_not_loaded: createReturn is not loaded. Find it with search_tools first.`

Journal `tool_call_rejected` with `reason: tool_not_loaded`; `tool_calls[].status = error`; the
call does not count toward `max_tool_calls`. A `tool_not_loaded` rejection is **not recorded for
§6.7 repeat detection**: a model that calls `load_skill("order-returns")` and `createReturn` in
one batch gets the rejection for the second call, and the same `createReturn` call on the next
step, when the tool is visible, executes normally instead of being refused as `repeated_call`.

### 5.6 Activation mechanisms

The engine picks one mechanism per run from the resolved model (section 7), writes it to
`run_start` as `activation`, and never mixes them within a run.

**`tool_reference`: Anthropic models with tool search** (Claude Opus 4.5 and later, Sonnet 4.5
and later, Haiku 4.5 and later, every Fable and Mythos; the model table of the tool search docs).

- The `tools` array sent to the provider contains **every** tool on **every** step, in this
  order: non-deferred tools sorted by name (built-ins among them), then deferred tools sorted by
  name with `defer_loading: true`. The array does not change within a run, and between turns it
  changes only when the request's tools change: the prefix is stable.
- `cache_control` goes on the **last non-deferred** tool; a deferred tool with `cache_control`
  is a `400`. There is always one: `load_skill` or `search_tools` is non-deferred.
- A `load_skill` or `search_tools` result is sent as a `tool_result` whose `content` is one
  `tool_reference` block per tool to activate, and nothing else; the text of sections 5.3
  and 5.4 follows as a `text` block in the same user turn, after the tool results. The live
  API refuses a `tool_result` that mixes the two ("Tool definitions/code execution functions
  cannot be mixed with other content"), although the schema lists both (section 14). The API expands the references into full definitions at that point of
  the conversation and keeps doing so on every later request, so the tools stay available for
  the rest of the session without re-loading, and the cached prefix is untouched.

  ```json
  { "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "toolu_01...",
      "content": [
        { "type": "tool_reference", "tool_name": "createReturn" },
        { "type": "tool_reference", "tool_name": "getReturnStatus" } ] },
    { "type": "text", "text": "[engine] Skill \"order-returns\" loaded. ...\n\n# Returns\n..." } ] }
  ```

  Only tools that are in the current `tools[]` **and deferred** get a reference: a reference to
  an absent tool is a `400`, a reference to a non-deferred tool is pointless.
- `tool_choice: none` steps (§6.7, §5.4 repair) keep the full array and send
  `tool_choice: { "type": "none" }`: the history holds references, and the API needs the
  definitions to resolve them. `@ai-sdk/anthropic` 3.x does exactly this (checked on 3.0.135);
  2.x dropped the tools on `none` instead, one of the reasons the SDK upgrade is a prerequisite.
  §6.7 point 3 is reworded accordingly.

**`tools_array`: everything else** (OpenAI-compatible providers, GigaChat, GLM, DeepSeek,
MiniMax through the Anthropic adapter, Anthropic models without tool search).

- The `tools` array of a step is the visible tools sorted by name. An activation adds tools to
  the next step's array; a provider with implicit prefix caching misses once on that step and
  caches the new prefix afterwards. Where the engine sets `cache_control` (MiniMax), it goes on
  the last visible tool, as today.
- The text of sections 5.3 and 5.4 is the whole `tool_result`.
- Providers with `honorsToolChoiceNone: false` get no tools on `none` steps, as today.

### 5.7 Restoration from history: statelessness

On every run the engine derives the activation state from `messages` before step 1:

1. **Loaded skills**: every assistant `tool_call` part with `tool: "load_skill"` whose paired
   `tool` message has `builtin: true` and `is_error: false`, taking `args.name`; kept if the name
   is in the current `skills[]`. A skill that is no longer in `skills[]` is just text in the
   history, no error.
2. **Found tools**: for every `tool` message of `search_tools` with `builtin: true` and
   `is_error: false`, `result.tools[]`; kept if the name is a deferred tool in the current
   `tools[]`.
3. Visible from step 1 = non-deferred + the deferred tools of loaded skills + found tools.
   Journal `skills_restored`.

Only `tool` messages with `builtin: true` (4.5) take part in steps 1 and 2, and only they are
rendered and pinned as built-in results below. A history may contain calls to an HTTP tool that
was named `load_skill` or `search_tools` before the harness adopted skills (4.4): such pairs have
no marker and stay ordinary history, rendered as today and activating nothing, even when the
result is a Markdown string that looks like a skill body. A marked message whose shape does not
match (for `load_skill`, `args.name` and `result` are strings; for `search_tools`, `result` is
`{ tools: string[], in_skills: Record<string, string> }`) is treated as ordinary history too,
with a `builtin_history_invalid` warning in the journal.

**Trimming keeps activations in context.** §5.1 trimming never drops a block that carries an
activation in effect: the assistant turn with a `load_skill` or `search_tools` call whose marked
result (4.5) loaded a skill of the current `skills[]` or activated a deferred tool of the current
`tools[]`, together with its tool messages. Such blocks are pinned like the first `user` message and the
last four messages. On `tool_reference` this is what keeps the model's tools in step with the
engine's visible set: the references live in those tool results, and a reference that left the
prompt would stop expanding while the engine still counted the tool as visible. On
`tools_array` it keeps the skill's instructions in context while the skill is in use. A history
whose pinned blocks alone do not fit the window fails `context_too_large`, as any history that
cannot be trimmed enough does today; shedding old skills is the harness's job (drop or rename the
skill, or compact the history). Pairs whose skill or tools are no longer in the request, and
error results, are not pinned.

Rendering is **deterministic** from the stored message and the current request. On
`tool_reference` the historical results are rendered again as references plus text, byte for
byte as in the run that produced them, as long as the request's tools, skills and locale did not
change: the prefix matches the cache and signed thinking blocks stay valid. A tool that left
`tools[]`, or stopped being deferred, drops out of the references (one cache miss, no error). On
`tools_array` the historical result is the text, and the tools are in the array.

The body in the history is the body **as loaded then**. If the harness edited the skill since,
the model keeps working with the old text in that session until it loads the skill again; the
history is never rewritten (§9.3). A harness that wants the new text in an existing session can
rename the skill.

### 5.8 Interaction with the rest of the contract

| Area | Effect |
|---|---|
| §5 `StoredMessage` | `tool.builtin: true` on engine-written built-in results (4.5); harnesses store it with the rest (H20) |
| §5.1 estimate | `system` includes the index; the tools counted are the visible ones |
| §5.1 trimming | blocks that carry an activation in effect are pinned and never trimmed (5.7), so the visible set always matches what the model sees |
| §6.1 | `tool_not_loaded` joins the pre-execution rejections |
| §6.2 | built-in results are never empty (a body is at least 1 byte, a search returns text) and never truncated |
| §6.3 | built-ins run inside the batch, in call order; they take microseconds |
| §6.4 | built-ins are `read`; a deferred `write` tool follows §6.4 once visible |
| §6.5 cancel | a built-in call interrupted mid-batch is sealed like any other |
| §6.6 SSE | `tool_call` and `tool_result` events as for any tool; `expose_args` shows the skill name or the query, `expose_result` the body or the search result |
| §6.7 | repeats and `tool_choice: none` apply unchanged, with one exception: a `tool_not_loaded` rejection is not a repeat candidate (5.5); `load_skill` and `search_tools` are disabled together with the rest |
| §7 result | `tool_calls[]` lists built-in calls with `builtin: true` (4.5), `effect: "read"`, the in-process `duration_ms`, `truncated: false`, `operation_id: null`; no other new fields |
| §10 | built-ins do not count toward `max_tool_calls`; they occupy a step; `max_total_tokens` and `max_cost` see the real prompt |
| §11.3 | nothing to retry |

## 6. Prompt caching (§9.3 addendum)

- Point 1 becomes: the tail of the **non-deferred** tools, the last one by name.
- Tools are still sorted by name; on `tool_reference` the deferred tools follow the non-deferred
  ones.
- The skill index is part of `system` and cached with it.
- On `tool_reference` a run with activations has the same prefix as a run without: the
  references live in the conversation body. On `tools_array` each activation step pays one
  prefix miss, and the next turn starts from the array the last step had, as long as the history
  activates the same tools (5.7): the miss is per activation, not per turn.

## 7. Provider capability (§9.2)

New `ResolvedModel.toolReferences: boolean`: `provider === "anthropic"` and the model matches
`/^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-(4-[5-9]|[5-9]|\d{2,})/i`: the model table
of the tool search docs, with later versions of the same lines matched in advance, like
`NEW_CLAUDE` in `factory.ts`. MiniMax uses the Anthropic adapter but **not** this flag: its API
has no `defer_loading`. `llm.capabilities` gets no override for it in this RFC.

## 8. Engine text: Appendix B additions

| Where | `en` |
|---|---|
| Skill index header (5.1) | `[engine] Skills. Before working on a topic a skill covers, call load_skill with its name: the instructions, and the tools the skill unlocks, arrive on the next step.` |
| Skill index line | `- <name>: <description>` |
| `load_skill` description | `Load a skill listed in the system prompt: returns its instructions and makes its tools available from the next step.` |
| `load_skill.name` description | `Skill name, exactly as listed.` |
| `search_tools` description | `Find tools that are not loaded yet, by what they do. Matching tools become available from the next step.` |
| `search_tools.query`, `.limit` | `What the tool should do, in a few words.`, `How many tools to return (1 to 20, default 5).` |
| Skill loaded (5.3) | `[engine] Skill "<name>" loaded. Tools available from the next step: <a>, <b>.` or `[engine] Skill "<name>" loaded.` |
| Unknown skill | `unknown_skill: <name>. Available skills: <a>, <b>.` |
| Search result (5.4) | `[engine] Tools available from the next step: <a>, <b>.` plus `Part of skills, load the skill first: <tool> (<skill>), ...` |
| Search without a match | `[engine] No tools match "<query>". Try other words for what the tool should do.` |
| Tool not loaded (5.5) | `tool_not_loaded: <tool> belongs to skill "<skill>". Call load_skill("<skill>") first.` or `tool_not_loaded: <tool> is not loaded. Find it with search_tools first.` |

The `ru` catalog gets the same keys. The machine parts (`unknown_skill:`, `tool_not_loaded:`,
names) do not depend on the locale.

## 9. Journal (§12.4)

| Event | Level | When | Fields |
|---|---|---|---|
| `run_start` | info | as today | adds `skills` (names), `activation` (`tool_reference` or `tools_array`), `tool_search` (bool); deferred tools are listed as `name:effect:deferred` |
| `skills_restored` | info | before step 1, only when something was restored | `skills`, `tools` |
| `builtin_history_invalid` | warn | a `tool` message with `builtin: true` whose shape does not match 5.7; treated as ordinary history | `call_id`, `tool` |
| `skill_loaded` | info | `load_skill` ok | `name`, `step`, `tools` (activated), `reloaded` |
| `skill_unknown` | warn | `load_skill` with an unknown name | content: `name` (model text, §12.2) |
| `tool_search` | info | `search_tools` executed | `limit`, `tools`, `in_skills`; content: `query` |
| `tool_call_rejected` | warn | as today | `reason: tool_not_loaded` is a new value |
| `step_start` | debug | as today | adds `tools_visible` |

Built-in calls do not emit `tool_call`, `tool_http` or `tool_result` journal events, which
describe HTTP endpoints; they do emit the SSE `tool_call` and `tool_result` events (§6.6).

Text the model wrote (the search `query`, the name passed to `load_skill` when it is unknown) is
tool input and may carry user data: it goes into the event's `content`, never into a metadata
field, which would reach stdout regardless of `LOG_PROMPTS` (§12.2). Names from the request
(`skills`, `tools`, `in_skills`) are harness data and stay metadata, like tool names today.

## 10. Harness obligations (Appendix A)

| # | Obligation | Section |
|---|---|---|
| H20 | Store the `tool` messages of `load_skill` and `search_tools` verbatim, `result` and `builtin` included: the engine restores loaded skills and found tools from them on the next run, and only marked messages count. | §5, §6.8 |

Recommendations, not obligations: keep the 3 to 5 most used tools non-deferred; put in a skill
what the model needs instructions for, defer what it needs only sometimes; one skill per topic,
with a description that says *when* to load it.

## 11. Conformance tests (§13 additions)

**Unit** (`test/unit-skills.test.ts`, `test/unit-tool-search.test.ts`, `unit-messages.test.ts`):
index text in `en` and `ru`, sorted by name, appended after `system`; the validation table of
4.4; BM25: camelCase split, argument names searched, positive scores only, `limit`, ties by name,
the 500-character cut; restoration from history (a loaded skill, a skill gone from `skills[]`, a
found tool gone or no longer deferred, error results ignored); rendering of a historical
`load_skill` result on `tool_reference`: references for present deferred tools only, the text after the tool results,
byte-identical to the live rendering; `estimateToolSchemaTokens` over visible tools only.

**Loop on the mock model** (`test/skills.test.ts`): `load_skill` on step 1 gives the header and
body as the tool result, the skill's tools are callable on step 2 and not on step 1
(`tool_not_loaded`), and `max_tool_calls` is not consumed; an unknown skill is an error and the
run continues; the same skill twice in a run is `repeated_call`; a skill restored from history is
visible on step 1 and a reload returns the body; `search_tools` activates `tools` on the next
step, does not activate `in_skills`, returns the no-match text, respects `limit`; on
`tools_array` the SDK call of step 2 carries the activated tools and step 1 does not; on
`tool_reference` every step carries all tools with `deferLoading` on the deferred ones,
`cacheControl` on the last non-deferred, the tool result of step 2 has `tool-reference` parts
only and the text follows it, and a `none` step still carries the tools; `tool_choice: none` after repeats disables
the built-ins too; a load on the last allowed step is not executed (§10.1); SSE events for
built-ins; `load_skill` and the skill's tool in one batch, then the same tool call on the next
step executes (no `repeated_call`); a history that overflows the window keeps the block with the
loaded skill and drops older blocks instead, on both mechanisms, and fails `context_too_large`
when the pinned blocks alone do not fit; a request without skills or deferred tools and an HTTP
tool named `load_skill` runs it as an HTTP tool, and the same request with `skills[]` is a
`400`; a history with an HTTP `load_skill` pair without `builtin: true` activates nothing, is
rendered as today and is not pinned, even when its result is a Markdown string; a marked pair
with a corrupt result is ignored with `builtin_history_invalid`; the engine's own `tool` messages
and `tool_calls[]` entries for built-ins carry `builtin: true`, HTTP ones do not.

**HTTP** (`http.test.ts`): `skills[]` round trip; `400` for a reserved name with the feature on,
for an unknown tool in a skill, and (v1.3.0) for a deferred tool outside every skill;
`tool_calls[]` carries the `load_skill` entry with `effect: read`; the `tool_search` journal
event has the query in `content` only.

**Live smoke** (`scripts/smoke.ts`, not in CI): Anthropic, a deferred tool behind a skill: the
`tool_result` with `tool_reference` plus `text` is accepted and the tool is called on the next
step; a second run with that history shows `cache_read_tokens > 0` on step 1.

## 12. Implementation plan

Work starts after the AI SDK v6 upgrade has landed.

**PR A: `skills[]`, `defer_loading`, `load_skill` (v1.3.0)**

1. `src/contracts.ts`: `SkillSchema`, `skills` in `RunRequestSchema`, `defer_loading` on
   `ToolDefSchema`, `builtin: z.literal(true).optional()` on `ToolMessageSchema` and
   `builtin?: true` on `ToolCallSummary`, `BUILTIN_TOOLS`, `SKILL_LIMITS`.
2. `src/runs/validate.ts`: the checks of 4.4, gated on the feature being used, including the
   v1.3.0-only "deferred but listed in no skill" check.
3. `src/providers/allowlist.ts` and `factory.ts`: the `toolReferences` capability and its regex.
4. `src/i18n.ts`: the texts of section 8, `en` and `ru`.
5. `src/runs/skills.ts` (new): the index text; built-in `ToolDef`s with localized descriptions;
   `restoreFromHistory(messages, request)` with the `builtin` filter and shape check of 5.7; the
   activation state (`visible`, `activate(names)`, `mechanism`); `renderBuiltinResult(message,
   request)` returning the text and the names to reference; `isPinned(block)` for trimming.
6. `src/runs/messages.ts`: `toModelMessages` takes the renderer; a built-in `tool` message
   becomes a `tool-result` with `output: { type: "content", value: [...] }` (one `custom` part
   with `providerOptions.anthropic = { type: "tool-reference", toolName }` per reference, then a
   `text` part) on `tool_reference`, and `{ type: "text" }` otherwise. `buildSystemMessages` gets
   the index appended to `system` inside the cached block. `trimHistory` takes a `pinned`
   predicate and never drops a pinned block (5.7).
7. `src/runs/runner.ts`: `buildToolSet(visible, deferred, mechanism, cacheEnabled)` per step,
   recomputed only when the visible set changed, with `toolTokens` recomputed alongside; in
   `executeToolBatch` the `tool_not_loaded` rejection (kept out of `seenCalls`, 5.5) and a
   built-in branch before `runSingleTool` that touches neither `toolCallsUsed` nor the call
   registry; the journal events of section 9, model text in `content` only.
8. `SPEC.md`: §4.2 fields and refusals, §5 (`tool.builtin`), §5.1, §6.1, the new §6.8, the §6.7
   wording on the SDK, §7 (`tool_calls[].builtin`), §9.2, §9.3, §12.4, §13, Appendix A H20,
   Appendix B. `ROADMAP.md`: 2.2 removed, one line in
   Phase 2 pointing here. `README.md`: one bullet under "Why".
9. The tests of section 11 except search; the smoke case.

**PR B: `search_tools` (v1.4.0)**

1. `src/tools/search.ts` (new): tokenizer, BM25, `searchTools(tools, query, limit)`.
2. `src/runs/skills.ts`: offer `search_tools` when a deferred tool is outside every skill;
   execute, render, restore found tools, pin the activating pairs.
3. `src/runs/validate.ts`: drop the "deferred but listed in no skill" check; reserve
   `search_tools` under the same gate as `load_skill`.
4. SPEC §6.8 search paragraphs, §4.2 refusals, Appendix B rows, the `tool_search` journal
   event; tests.

Both PRs are additive and each release is self-consistent: v1.3.0 cannot accept a deferred tool
that nothing activates, v1.4.0 gives such tools `search_tools`. The tag goes after A alone or
after both, whichever is ready.

## 13. Alternatives considered

- **Harness-side loading**: a `load_skill` HTTP tool whose result ends the run, after which
  the harness rebuilds the request with the skill and starts a new run. No engine change, but a
  full run, a callback and a harness round trip per skill on the hottest path, and the harness
  has to track what is loaded. Rejected.
- **A meta-tool `call_tool(name, args)`** with tool descriptions as text. Cache-neutral
  everywhere, but it loses the native argument schema: §6.1 validation and argument quality on
  weaker models. Rejected as the primary mechanism.
- **Implicit deferral** (a tool listed in a skill is deferred). One field less for the harness,
  but a skill may legitimately describe tools that should stay visible, and a tool silently
  leaving the prompt because it was added to a skill is a surprise. Explicit `defer_loading`.
- **The provider's server-side `tool_search_tool_bm25`** instead of the engine's
  `search_tools`. It saves one step on Anthropic, but the model would see a different tool on
  different providers, the search would not run in conformance tests, and the results would not
  be reproducible from the request. The engine's BM25 is the same code everywhere; the server
  tool can come later as an opt-in optimisation without a contract change.
- **The skill body as a mid-conversation system message** (`tool_addition` plus a system
  message, Claude 5.5 and later). Operator weight for the text, but a beta header, a model
  subset, and no benefit over a `tool_result` the model asked for. Not used.
- **`tool_removal`**, removing a tool mid-run. No scenario: the harness re-scopes the tools on
  every run, and §6.7 handles a model that misuses a tool. Out of scope.
- **Deferred tools with no path to them** (no skill, no search). Impossible by construction:
  a deferred tool outside every skill turns `search_tools` on.

## 14. To verify during implementation

1. A `tool_result` whose `content` mixes `tool_reference` and `text` blocks: the Messages API
   schema lists both, but the live API answers `400` ("cannot be mixed with other content").
   Resolved in 5.6: references only in the `tool_result`, the text right after it in the same
   user turn. The smoke case passes with that shape, and the second turn reads the cache.
2. `@ai-sdk/anthropic` 3.x: a `custom` tool-result content part with
   `providerOptions.anthropic.type === "tool-reference"` is emitted as `tool_reference`, and
   `toolChoice: "none"` keeps the tools array. Both read from the 3.0.135 build; re-check on the
   version pinned by the upgrade PR.
3. Context accounting on `tool_reference`: the expanded definitions count as input tokens
   (provider docs); the estimate counts visible tools, so the two should agree.
