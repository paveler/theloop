# RFC 0002: Final answer on limits, and a journal on disk

| | |
|---|---|
| Status | Implemented in v1.2.0 (2026-10-28) |
| Scope | Part A changes the outcome of `stopped_limit / max_steps` and `stopped_limit / max_tool_calls` (an answer is now always present). Part B is additive: a new journal backend, `GET /logs` keeps its contract |
| Target | v1.2.0 (both parts; they are independent) |
| Touches | SPEC §6.7, §10.1, §12.4, §14, Appendix B; `src/runs/runner.ts`, `src/log-buffer.ts`, `src/log.ts`, `src/config.ts` |

## 1. Summary

**A. A run never ends on a limit without an answer.** Today, when the model spends the last
allowed step on tool calls, the engine seals those calls and ends the run
`stopped_limit / max_steps` with an empty answer. The harness has nothing to show the user, so
the user sees an error after waiting through every step. With this RFC the engine reserves the
last step for an answer: that step goes with `tool_choice: none` (the same mechanism as §6.7
rule 3) and a short engine note telling the model to answer with what it has. If the model still
produces no text, the engine fills the answer with a fixed localized fallback. `max_tool_calls`
gets the same treatment.

**B. The journal survives restarts and keeps a week.** Today the journal is a ring buffer in
process memory: a deploy wipes it, and the 32 MB ceiling plus the 4000-char content cap cut away
exactly the parts needed to debug a bad answer (the end of `system`, where the per-run context
lives, and long tool results). With this RFC the engine also writes the journal to disk as daily
JSONL files, deletes files older than 7 days, stores each distinct `system` once by hash instead
of in every `run_start`, and serves `GET /logs` from disk when the memory buffer no longer has
the range.

## 2. Motivation

### 2.1 Silent death on `max_steps`

A real run (weak model, 8 steps, ~13 k tokens of system prompt):

```
step 1–5  lookup_code(...)      × 5   codes the model already had in context
step 6    lookup_area("<city>")       empty: the tool takes areas, not cities
step 7    lookup_area("<area>")       ok
step 8    get_results()               tool call on the last step
          limit_hit max_steps → tool_calls_sealed → run_done stopped_limit, no answer
```

Every step was "legitimate" for §6.7: different arguments, no repeats, no empty-twice. The
model needed one more step to write the answer and never got it. The user waited 11 s and got
an error. Prompt fixes reduce how often this happens; they cannot make it impossible, and the
failure mode is the worst one possible: work done, nothing said.

The step budget exists to bound cost and latency, not to suppress the answer. One extra
text-only call is cheap next to the steps already spent, and it turns a hard failure into a
partial answer ("I found the code for the area, here is the card" or "I did not finish, here is
what is left").

### 2.2 The journal loses what matters

- **Deploy = empty journal.** The question "why did it answer that" usually comes hours later,
  often after a deploy.
- **Content is cut where the context is.** The harness typically puts stable instructions first
  and per-run context (state, profile, current entity) at the end of `system`. A 4000-char cap
  keeps the stable part, which is known anyway, and drops the per-run part, which is what one
  needs to see. Raising the cap in memory multiplies RAM: every `run_start` repeats the same
  ~20–30 KB of instructions.
- **32 MB of RAM** holds a few hundred full runs; a busy hour evicts the morning.

## 3. Part A: final answer on limits

### 3.1 Last step is text-only

Change to §10.1 rule 1. When `step == max_steps` and `max_steps > 1`, the step is built with
tools disabled exactly as §6.7 rule 3 does it (`tool_choice: none` for providers that support
it; no tools on the step for providers that do not, tool pairs stay in the history). The engine
appends one **ephemeral** engine note (Appendix B) to the prompt of that step only:

> `[engine] Step limit reached: tools are unavailable on this step. Answer the user now with
> what you already have: what is done, what is not, and what the user can do next. Do not
> promise to call tools.`

The note is not stored in `messages` and not returned in the result; it is visible in the
journal (`step_start.content.engine_note`).

Consequences:

- `max_steps` still bounds model calls. The model gets `max_steps - 1` steps with tools instead
  of `max_steps`. This is the intended trade: a tool call on the last step was never executed
  anyway (§10.1 rule 1), so no reachable behavior is lost.
- If the model answers in text, the run ends **`completed / end_turn`** with
  `limit_reached: "max_steps"` in the result and in `run_done`. It is a normal answer; the
  harness renders it as usual. Format checks (§5.4) apply to it as to any final text.
- If the provider ignores `none` and returns tool calls anyway, they are sealed as today
  (`not_executed: max_steps`), and the answer falls through to 3.3.

### 3.2 `max_tool_calls`

Change to §10.1 rule 2. When a batch is refused because it exceeds the remaining
`max_tool_calls`, the batch is still not executed (all-or-nothing stays), but the run does
**not** end: the next step goes text-only as in 3.1, with the note's first sentence replaced by
`Tool call limit reached: tools are unavailable from now on.` The same applies when
`max_tool_calls` is used up exactly: all following steps are text-only. If that step is beyond
`max_steps`, it is one extra call outside `max_steps` (like format repair steps, §5.4: outside
`max_steps`, inside budgets). Result: `completed / end_turn`, `limit_reached: "max_tool_calls"`.

### 3.3 Fallback text

If the text-only step returns no text (empty, tool calls only, provider error after retries,
or the budget check of §10.2 refuses the call), the run ends `stopped_limit / <limit>` as today,
but `answer` is **not empty**: it carries a fixed localized fallback (Appendix B):

> en: `I ran out of steps before finishing. Please send the request again, or narrow it down.`
> ru: `Не успел закончить за отведённые шаги. Отправьте запрос ещё раз или уточните его.`

with `answer_source: "fallback"` in the result. The harness may show its own text instead; the
point is that "no answer" is never the engine's output for these two limits.

Not changed: `max_tokens` (text is kept, `partial: true`), `max_total_tokens` / `max_cost` when
the budget is already exhausted before the text-only step (fallback per 3.3 applies),
`cancelled`, timeouts.

### 3.4 Contract

- New optional result field `limit_reached: "max_steps" | "max_tool_calls"` on `completed`
  runs that hit a limit and still answered. Old harnesses ignore it.
- New optional result field `answer_source: "model" | "fallback"`; absent means `model`.
- `stopped_limit / max_steps | max_tool_calls` now carries a non-empty `answer`. A harness
  that treated `stopped_limit` as "show an error" SHOULD render `answer` when it is non-empty.
- Opt-out per request: `limits.final_answer: false` restores today's behavior exactly (for
  callers that rely on `stopped_limit` to trigger continuation logic).

### 3.5 Journal

- `step_start` gains `final_answer_step: true` and `content.engine_note`.
- New event `final_answer` (info): `run_id`, `limit`, `outcome: model | fallback`, `reason`
  when `fallback` (`empty_text`, `tool_calls_ignored_none`, `provider_error`, `budget`).
- `run_done` gains `limit_reached`.

### 3.6 Tests (§13)

- `max_steps = N`, model calls tools on steps 1..N-1 → step N is sent without tools / with
  `tool_choice: none`, carries the note, run `completed`, `limit_reached: max_steps`.
- Same, provider returns tool calls on step N → calls sealed `not_executed: max_steps`,
  run `stopped_limit`, `answer` = fallback in run locale, `answer_source: fallback`.
- `max_steps = 1` → unchanged (no tools-off step; the single step is the run).
- Batch larger than remaining `max_tool_calls` → batch not executed, next step text-only,
  run `completed`, `limit_reached: max_tool_calls`; extra step counted outside `max_steps`.
- Budget exhausted before the text-only step → fallback, no provider call.
- Format check on the final text → applied, repair steps work as before.
- `limits.final_answer: false` → byte-identical to v1.4 behavior.
- Locale `ru` / `en` for note and fallback.

## 4. Part B: journal on disk, 7-day retention

### 4.1 Storage

- Directory `LOG_DIR` (default unset = disk journal off, today's behavior). When set, every
  journal entry is appended to `LOG_DIR/journal-YYYY-MM-DD.jsonl` (UTC date of the entry), one
  JSON object per line, the same shape as `GET /logs` entries. Writes are buffered and flushed
  at least every second and on SIGTERM (§11.1), so a deploy loses at most the last second.
- **Prompts by hash.** `run_start.content.system` is replaced with `system_sha256` (hex). The
  first time a hash is seen in a day file, the full text is written once as an entry
  `prompt_blob { sha256, text }` in the same file. The in-memory buffer does the same, which
  also cuts RAM per run. `GET /logs` inlines the text back by default, so readers see `system`
  as before; `?inline_prompts=false` returns hashes only.
- **No content cap on disk.** `LOG_CONTENT_MAX_CHARS` keeps applying to the in-memory buffer
  and stdout. A separate `LOG_DISK_CONTENT_MAX_CHARS` (default 200 000) is a safety net against
  pathological tool results. Secret scrubbing (§12.4) applies identically on disk.
- **Retention.** On startup and then hourly, files with a date older than
  `LOG_RETENTION_DAYS` (default 7) are deleted. Optional ceiling `LOG_DIR_MAX_BYTES` (default
  2 GB): when exceeded, the oldest whole day files are deleted first and a `journal_pruned`
  warning is logged. The current day file is never deleted.

### 4.2 Reading

`GET /logs` and `GET /runs/{id}/logs` keep their parameters and response shape. Resolution
order: memory buffer first; if the requested range (`session_id`, `run_id`, `since`, or the
default tail) is not fully covered by memory (`oldest_at` later than what is asked), the engine
scans day files newest-first until `limit` is satisfied. Scanning is streaming (line by line), with
a `session_id` / `run_id` prefilter on the raw line before JSON parse. A new optional
`?days=N` (default: all retained) bounds the scan. The response gains `source: memory | disk |
mixed`.

`run_id → session_id` for runs only on disk is recovered from their `run_start` line.

### 4.3 Deployment

- Needs a **persistent volume** mounted at `LOG_DIR`; on a platform without one the files live
  as long as the container and Part B degrades to "survives nothing, but no RAM ceiling".
  The engine logs `journal_disk_ephemeral` at startup if `LOG_DIR` is on the container's root
  filesystem (same device as `/`), as a hint, not an error.
- Single instance (§11.2): one writer, no locking. If several instances ever share a volume,
  each must use its own subdirectory (`LOG_DIR/<instance>`); out of scope here.
- Size estimate: ~30 KB per run with `system` deduplicated (history tail, tool results, model
  texts), × 2 000 runs/day ≈ 60 MB/day, ≈ 420 MB per week. Prompts add a few hundred KB per day.

### 4.4 Privacy

The disk journal holds the same content as the memory journal, which already includes user
messages and tool results. Retention is the control: 7 days by default, `LOG_RETENTION_DAYS=0`
keeps only the current day. `LOG_BUFFER_CONTENT=0` disables content on disk too. The files are
readable only by the engine user (`0600`, directory `0700`).

### 4.5 Config

| Variable | Default | Meaning |
|---|---|---|
| `LOG_DIR` | unset | enable the disk journal |
| `LOG_RETENTION_DAYS` | 7 | delete day files older than this |
| `LOG_DIR_MAX_BYTES` | 2 147 483 648 | ceiling for the directory, oldest days dropped first |
| `LOG_DISK_CONTENT_MAX_CHARS` | 200 000 | per-field cap on disk |

### 4.6 Tests

- Entries written to the right day file; flush on SIGTERM.
- Same `system` in 100 runs → one `prompt_blob` per day file; `GET /logs` returns full `system`.
- Restart → `GET /logs?session_id=` returns the session from disk, `source: disk`.
- Memory evicted, disk has it → `source: mixed`, order by `seq` then `at` preserved.
- Retention: files older than N days deleted on startup and on the hourly tick; current day kept.
- `LOG_DIR_MAX_BYTES` exceeded → oldest days dropped, `journal_pruned` logged.
- Secrets scrubbed on disk the same way as in memory.

## 5. Open questions

1. `seq` across restarts: memory `seq` restarts at 0. Proposal: disk entries carry
   `boot_id` + `seq`; `since` keeps meaning "after this seq in the current boot", and disk-only
   reads ignore `since`.
2. Should the text-only last step be skipped when the model already answered with text plus
   tool calls on step N-1? Proposal: no; keep the rule simple.
3. Should `limit_reached` runs be `completed` or a new status? Proposal: `completed`; a new
   status would break every harness switch for little gain.
