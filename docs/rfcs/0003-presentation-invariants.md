# RFC 0003: Presentation invariants

| | |
|---|---|
| Status | Implemented in v1.2.0 (2026-10-28); open questions answered as proposed |
| Scope | Additive. Every part is opt-in through new request fields; a request without them behaves exactly as without this RFC |
| Target | v1.2.0, together with RFC 0002 |
| Touches | SPEC §4.2, §5.4, §6.3, §6.7, §7, §12.4, §13, Appendix B; `src/contracts.ts`, `src/runs/runner.ts`, `src/runs/output-checks.ts`, `src/i18n.ts` |

## 1. Summary

The harness often turns parts of a run into UI: a tool result becomes a card or a list under
the answer, a fenced block in the answer becomes a card with a button (§5.4). The engine does
not know which parts are UI, so it cannot keep the run coherent from the user's point of view.
Weak models exploit every gap: two cards in one answer, a card written in the middle of a tool
step and then copied on every following step, a card filled with codes the model made up
instead of taking them from a tool.

This RFC lets the harness mark what is shown to the user and adds four engine invariants on top:

- **A. One presentation per run.** Tools and fences can be marked `presents`; at most
  `limits.max_presentations` of them reach the user in one run. Later presenting tools are
  hidden and refused, later presenting fences are cut.
- **B. Blocks belong to the final answer.** A fenced block of an `output_checks` fence written
  in a step that also calls tools is dropped from that step, both from the stored message and
  from what the model sees next.
- **C. Configurable repeat tolerance.** `limits.max_repeated_calls` sets how many repeats
  (§6.7) the engine tolerates before switching to `tool_choice: none`; `0` disables tools on
  the first repeat.
- **D. Grounded values.** `output_checks[].grounded` requires values at given paths of a block
  to come from results of given tools; anything else is a validation error and goes through
  the normal repair (§5.4).

None of this is model-specific. The engine enforces invariants of the conversation, not
workarounds for one provider; the same rules hold for a strong model, which simply never
trips them.

## 2. Motivation

A real run, anonymized (weak model, help-desk-like assistant; `show_items` returns a list the
harness renders as a card deck; `action-card` is an `output_checks` fence the harness renders
as a card with an "Apply" button; the prompt says "do not call `show_items` before the user
applies a card" and "never write the card in the same answer as a tool call"):

```
user     "why do I see items from <area>?"
step 1   text: explanation + ```action-card {remove: ["91"]}```   tool: lookup_area("<area>")
         (code "91" written before the lookup; the lookup returns "82")
step 2   text: ```action-card {remove: ["82"]}``` + text           tool: show_items()
         show_items executed: the deck goes to the user
step 3   text: same card                                            tool: show_items()  repeat 1
step 4   text: same card                                            tool: show_items()  repeat 2
         tools_disabled
step 5   text: same card                                            -> final answer
```

What the user got: a deck of items nobody asked for, and a card. What the history got: four
copies of the card in intermediate assistant messages, one of them with an invented code.
Each defect has a prompt rule against it, and the model broke every rule. The engine had all
the information to prevent each one:

1. **Two presentations in one run.** The deck and the card compete for the same screen and
   answer different questions. The harness cannot drop one after the fact without the answer
   text referring to something that is not shown.
2. **A block in a tool step.** The format gate (§5.4) checks only the final answer, so the
   step 1 block with `"91"` was never validated. Kept in the provider history, every block is
   an example the model copies on the next step; the four identical cards in steps 2–5 are
   exactly that.
3. **Two repeats tolerated.** §6.7 warns on the first repeat and disables tools on the second.
   For a tool with a visible effect (a deck under the answer), the first repeat is already a
   loop; some harnesses want the cut there.
4. **An invented code.** The card schema can say "a string of two digits"; it cannot say "a
   string that some `lookup_area` result returned". The harness can only check this after the
   run, when the model can no longer fix it.

Prompt changes reduce how often these happen. They cannot make them impossible, and stuffing a
shared system prompt with rules for the weakest model makes it worse for the others.

## 3. Part A: one presentation per run

### 3.1 Contract

```json
"tools": [ { "name": "show_items", "effect": "read", "presents": true, "…": "…" } ],
"output_checks": [ { "fence": "action-card", "schema": { }, "presents": true } ],
"limits": { "max_presentations": 1 }
```

| Field | Meaning |
|---|---|
| `tools[].presents` | `true` — a successful result of this tool is rendered to the user by the harness. Default `false`; `null` means the same. |
| `output_checks[].presents` | `true` — a block of this fence is rendered to the user. Default `false`. |
| `limits.max_presentations` | Integer ≥ 1. Absent — no limit, Part A is inert even if `presents` is set. Not clamped; there is no engine default. |

A **presentation** is counted when:

- a presenting tool call finishes with outcome `ok` (§6.2), including an `accepted` call that
  later resolved `ok`. Errors, rejected calls (§6.1), repeats (§6.7) and refused calls (§3.2)
  are not presentations: nothing was shown;
- the final answer contains a block of a presenting fence that is `passed` or `repaired`
  (§5.4). `failed` and `absent` are not presentations.

`deferred` write tools are not counted: the harness shows their approval cards, and the run
ends `awaiting_tool` anyway (§6.4).

### 3.2 When the budget is spent

From the step after the one in which the last allowed presentation happened:

1. **Presenting tools are hidden.** They are left out of the tool list sent to the provider,
   the same way §6.7 rule 3 leaves tools out for providers without `tool_choice: none`. Other
   tools stay. If no tools remain, the step goes with `tool_choice: none`.
2. **A call to a hidden presenting tool is refused**, like `tool_not_loaded` (§6.8): the
   endpoint is not called, the model gets `{ is_error: true, error: "presentation_limit: …" }`
   in the run locale (Appendix B) — *the user already sees a result of this run; answer in
   text about what is shown* — and `tool_calls[].status = presentation_limit`. A refused call
   is recorded for §6.7: repeating it counts as a repeat.
3. **Presenting fences in the final answer are cut** without repair: the block is removed from
   the final message as for `failed` (§5.4), `output_checks[].status = suppressed`,
   `reason: presentation_limit`. The rest of the text stays.

**Within one step**, presenting calls are admitted in the model's tool-call order (§6.3): the
first `max_presentations − used` calls run, the rest are refused by rule 2 before any endpoint
is called. Admission is decided before execution, so a later call is refused even if an
earlier admitted one fails; the model can retry the refused one on the next step if no
presentation happened.

Tools win over fences by construction: a fence counts only in the final answer, which comes
after every tool step. A harness that wants the card to win hides the competing tool from that
run (§7, non-goals).

### 3.3 Interaction with other rules

- `max_tool_calls` (§10.1) is checked first: a batch over the remaining call budget is not
  executed at all, and nothing is counted.
- The text-only final step on a limit (RFC 0002) and repair steps (§5.4) never call tools, so
  they never present through tools; a presenting fence in their output is subject to rule 3.
- Skills (§6.8): a deferred presenting tool activated by `load_skill` after the budget is
  spent stays hidden.

### 3.4 Result and SSE

- `tool_calls[].status` gains `presentation_limit`.
- `output_checks[].status` gains `suppressed`, with `reason: presentation_limit`.
- `result.presentations: [{ kind: "tool" | "fence", name, call_id? }]` — in order of
  occurrence, only when `max_presentations` is set. The harness may use it instead of
  reconstructing the list from `tool_calls`.
- SSE: `tool_call` / `tool_result` for a refused call are emitted as for a rejected call;
  `output_check { fence, attempt: 0, status: "suppressed" }`.

## 4. Part B: blocks belong to the final answer

### 4.1 Contract

```json
"output_checks": [ { "fence": "action-card", "schema": { }, "interim": "drop" } ]
```

| `interim` | Meaning |
|---|---|
| `keep` (default) | v1 behavior: text of tool steps is stored and replayed as is. |
| `drop` | Blocks of this fence in the text of a step that ends with tool calls are removed. |

### 4.2 Behavior with `drop`

An **interim step** is a main step whose `finish_reason` is `tool-calls`. When it finishes:

1. Every block of a `drop` fence, closed or not, is removed from the step text (block
   detection as in §5.4). Surrounding text stays; if nothing but whitespace remains, the text
   part is omitted and the stored assistant message carries only its tool calls.
2. The cleaned text is what goes into `messages` and what the provider sees on the next step.
   The original lives only in the journal.
3. Nothing is repaired: the model will get another chance to write the block in the final
   answer, where the gate (§5.4) validates it.

Why not validate interim blocks instead: an interim block answers a question the step has not
finished asking. The model is still waiting for tool results that may change the block (in
§2, the code came back different from the one already written). Validating it would accept a
block that is valid and wrong.

### 4.3 SSE

Interim text has already been streamed when the step finishes. The engine emits
`output_check { fence, attempt: 0, status: "dropped", step }` right after the step's `step`
event. A client that renders blocks from the live stream removes the block of that step; a
client that renders from the final message (§5.4: the truth is the final message) needs to do
nothing.

## 5. Part C: configurable repeat tolerance

```json
"limits": { "max_repeated_calls": 0 }
```

| Value | Behavior |
|---|---|
| absent / `1` | v1 (§6.7): the first repeat is a warning, the second disables tools. |
| `0` | The first repeat disables tools: the repeat gets its usual synthetic error, and the next step goes with `tool_choice: none`. |
| `n > 1` | Tools are disabled on repeat `n + 1`. Clamped to 3. |

Rule 4 of §6.7 (empty results) is unchanged. The `tools_disabled` event keeps its fields and
adds `max_repeated_calls`.

## 6. Part D: grounded values

### 6.1 Contract

```json
"output_checks": [ {
  "fence": "action-card",
  "schema": { },
  "grounded": [ { "path": "/rules/*/codes/*", "tools": ["lookup_area", "lookup_category"] } ]
} ]
```

| Field | Meaning |
|---|---|
| `grounded[].path` | A JSON Pointer into the block; `*` matches every array index or object key at that level. Up to 8 entries per check. |
| `grounded[].tools` | Tool names. A value at `path` is grounded if it equals a scalar found anywhere in an `ok` result of one of these tools. |

### 6.2 Semantics

- The search space is every `ok` `tool` message of the listed tools in the request history and
  in this run, up to the call that produced the block. Results truncated by
  `tool_result_max_bytes` are searched as truncated.
- Values compare as strings after `String()`; strings are compared exactly (no case folding,
  no trimming). Objects and arrays at `path` are not grounded by structure: put the pointer on
  the scalars.
- A path that matches nothing in the block is fine; grounding constrains values, not presence.
  Presence is the schema's job.
- An ungrounded value is a validation error of the block, checked after the schema passes.
  It goes through the §5.4 repair with the error line, in the run locale:

  ```
  - /rules/0/codes/0: "91" is not among the values returned by lookup_area, lookup_category
  ```

  Repair steps run with `tool_choice: none`, so the model cannot call the lookup now; the
  error tells it to use a returned value or drop the item. If repairs run out, the block is
  `failed` and cut, as today.
- `output_checks[].errors` and the journal report grounding errors like schema errors; the
  error path is the concrete path (`/rules/0/codes/0`), the code is `ungrounded`.

### 6.3 What it does not do

It does not check meaning: `"82"` returned for one query and reused for another passes. It is
a provenance check against invention, not a semantic validator. Values the engine never saw in
a tool result (for example, ids the harness put into `system`) cannot be grounded this way;
the harness puts them into the schema as an `enum` instead — the schema is per request.

## 7. Non-goals and harness recipes

- **Tool preconditions.** "Call `show_items` only after the user applied a card" is not an
  engine rule. `tools[]` is per request: the harness simply does not send `show_items` on a run
  that did not start from that event. A tool the model cannot see is a rule it cannot break.
- **Choosing between a tool and a card.** If a card must win, the harness does not send the
  competing presenting tool on that run (or marks only the fence `presents`).
- **Rendering.** The engine never learns what a presentation looks like; `presents` is a single
  bit.
- **Model-specific prompting.** Nothing here changes text the model sees except the localized
  refusal and repair lines.

## 8. Journal (§12.4)

| event | level | when |
|---|---|---|
| `presentation` | info | a presentation counted: `kind`, `name`, `call_id?`, `used`, `max` |
| `presentation_limit` | warn | a presenting call refused or a fence suppressed: `kind`, `name`, `call_id?`, `step`; content — `args` |
| `interim_block_dropped` | warn | Part B removed blocks: `fence`, `step`, `blocks`; content — the original step text |
| `output_check` | — | adds `outcome: ungrounded` with `errors` for Part D; `suppressed` for Part A |
| `tools_disabled` | — | adds `max_repeated_calls` |
| `step_start` | — | `tools_visible` excludes hidden presenting tools; adds `presentations_used` |

## 9. Tests (§13)

Part A:
- two presenting tools in one step with `max_presentations: 1` → the first runs, the second is
  refused with `presentation_limit`, its endpoint is never called;
- a presenting tool in step 1, the same tool in step 2 → hidden from the step 2 tool list;
  a call anyway → refused, then a repeat of the refused call counts for §6.7;
- a presenting tool that errors does not spend the budget;
- tool presented, final answer with a presenting fence → block cut, `suppressed`, text kept;
- no `max_presentations` → `presents` has no effect (v1 parity);
- deferred presenting tool activated by a skill after the budget is spent stays hidden.

Part B:
- interim step with a block and a tool call, `drop` → stored message and next-step provider
  history without the block; SSE `output_check dropped`; journal keeps the original;
- interim step with only a block → stored assistant message has only the tool call;
- unclosed interim block → dropped to the end of the text;
- `keep` → v1 parity.

Part C:
- `max_repeated_calls: 0` → first repeat disables tools, the run completes with text;
- clamping above 3.

Part D:
- value present in a history result → passes; only in a result after the block → fails
  (cannot happen in practice, but the order is defined);
- ungrounded value → repair with the `ungrounded` line; fixed → `repaired`; not fixed → `failed`;
- `*` over arrays and object keys; numbers compared as strings;
- a path matching nothing → passes.

## 10. Open questions

1. **Priority instead of order.** Should the harness be able to say "a fence beats a tool"
   inside one run (`presents: { priority }`)? It needs the engine to hold back a tool result
   until the final answer is known, which breaks streaming of tool progress. Current answer:
   no, use §7.
2. **Interim text in general.** Some harnesses would rather drop all interim text, not only
   blocks (it reads like a premature answer). Out of scope here; `interim` could later accept
   a run-level form.
3. **Grounding against `system`.** A harness-provided list (`grounded[].values`) would cover
   ids that never pass through a tool. It duplicates `enum` in the schema; deferred until a
   case appears that `enum` cannot express.
