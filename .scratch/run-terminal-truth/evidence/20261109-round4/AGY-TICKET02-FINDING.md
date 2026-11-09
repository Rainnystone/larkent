# Ticket 02 Diagnosis — Current-Turn Error Attribution in `agy 1.5.3`

- **Worktree / Branch / Base:** `/workspace/rt-agy-fix` · `work/agy-turn-attribution` · `aabcefe68e148a153f89f57660009bb62ec65b28`
- **Phase:** Diagnosis-only evidence gate (no product edits, no commits/pushes, no new live probes, no network/auth/model changes)

---

## 1. Verdict: **NO**

There is **no reliable universal current-turn error discriminator** in `agy 1.5.3` `stream-json` stdout (or paired stderr) that separates all genuine current-turn errors from historical sticky errors carried over onto subsequent resumed turns.

Specifically:
1. **`result` fields (`status`, `error`, `finished_reason`, `duration_seconds`, `num_turns`) do not discriminate current vs. historical error ownership:**
   - Across both the Feishu test-bridge capture (`01-seed-ping-safe.json`, `01-anomaly-for-agy.json`) and the raw CLI `streamGenerateContent` Bad Gateway captures (`01-sticky-probe.jsonl`, `01-cli-capture-v5-proxy-success-still-error.jsonl`, `01-cli-capture.jsonl`), once a mid-session turn records `status: "ERROR"`, a subsequent resumed turn (`--conversation <id>`) that succeeds and replies (`PONG-01`, process exit `0`) still emits `result.status: "ERROR"`, `result.finished_reason: "error"`, and a byte-identical `result.error` string.
   - Raw `result` objects on `ERROR` turns contain only `["conversation_id", "duration_seconds", "error", "finished_reason", "num_turns", "response", "status", "usage"]` (`01-seed-ping-safe.json:70-79`, `01-sticky-probe.jsonl:5,10`). Neither `error_code`, `error_type`, `error_id`, nor any origin-turn field exists on `result`.
   - Even `result.duration_seconds` was observed sticky across turns (`PING` `duration_seconds: 5.612337043` byte-equal to `SEED` `duration_seconds: 5.612337043` in `01-anomaly-for-agy.json:26,55`).
2. **`step_update` ordering (`user_input` / `error_message`) is sufficient when `error_message` is present, but is falsified as a necessary condition for genuine current-turn errors:**
   - In R2 (`stdout-agy-f11893f7-1598-408d-acb9-baa4dd70842a.jsonl:3-6`), the stream emitted `step_index: 8` (`user_input`, `DONE`) → `step_index: 9` (`system_message`, `DONE`) → `step_index: 10` (`error_message`, `DONE`) → `result` (`status: "ERROR"`, `num_turns: 4`), whereas PONG (`r2-vs-ping-pong-compare.json:29-65`) emitted `step_index: 4` (`user_input`) → `5,6` (`system_message`) → `7` (`agent_response` `ACTIVE`/`DONE`) with no `error_message` step.
   - However, **PING** (`stdout-agy-10a55686-e56d-463c-9d8e-934d73ff4569.jsonl` via `01-seed-ping-safe.json:53-81` and `r2-vs-ping-pong-compare.json:3-20`) was a **genuine current-turn error** (`num_turns: 2`, immediately following `SEED` `num_turns: 1` `SUCCESS`) and emitted **only `init` and `result` (`steps: []`) — zero `user_input` and zero `error_message` steps**.
   - Similarly, pre-attachment eligibility failures (`01-cli-capture-v4-eligibility-on-resume.jsonl:42-43`) emit `result` (`status: "ERROR"`, `num_turns: 0`) with zero `step_update` events.
3. **Structured `AGY_ERROR` (`error_id` with `-<step_index>` suffix) on stderr is not universal:**
   - R2 emitted `AGY_ERROR: {...,"error_id":"a91dfcea-dbea-418e-83d9-584af6e5ef18-10"}` on stderr (`R2-CORRELATED-DESKTOP.md:23`), and `streamGenerateContent` Bad Gateway emitted `AGY_ERROR` on stderr (`01-cli-capture-v3-sameproc-exit.jsonl:21`, `01-cli-capture.jsonl:17`).
   - However, PING's genuine turn-2 error (`MODEL_PLACEHOLDER_M418` executor construction failure / `error: timeout waiting for cascade to start running`) emitted **no `AGY_ERROR` blob on stderr** (`01-seed-ping-safe.json:43`, `01-anomaly-for-agy.json:43`), and eligibility-check errors on resume also emitted **no `AGY_ERROR` blob** (`01-cli-capture-v4-eligibility-on-resume.jsonl:42`).
   - In addition, the stdout `error_message` step itself (`stdout-agy-f11893f7-1598-408d-acb9-baa4dd70842a.jsonl:5`) contains only `{"conversation_id":"...","step_index":10,"state":"DONE","step_type":"error_message"}` with no `error_id` or message payload.

---

## 2. Falsifying Cases Checked

| Candidate Rule / Marker | Positive Case Where It Holds | Falsifying Case (Evidence Reference) | Why It Fails |
| --- | --- | --- | --- |
| **R1: Trust `result.status === "ERROR"` or `result.error` / `result.finished_reason === "error"`** (current `src/agent/antigravity/jsonl.ts:151-156`) | Genuine errors: PING (`01-seed-ping-safe.json:63-80`), R2 (`stdout-agy-f11893f7-1598-408d-acb9-baa4dd70842a.jsonl:6`), Turn 2 Bad Gateway (`01-sticky-probe.jsonl:5`). | **PONG** (`01-seed-ping-safe.json:107-124`, `r2-vs-ping-pong-compare.json:22-75`) and **ProcB Turn 3** (`01-sticky-probe.jsonl:10`, `01-cli-capture.jsonl:31`). | `result.status`, `result.error`, and `result.finished_reason` remain sticky (`ERROR`) on subsequent resumed turns that actually succeed (`response: "PONG-01\n"`, exit `0`). |
| **R2: Require `step_update` with `step_type === "error_message"` after `user_input` to treat `result.status === "ERROR"` as current-turn failure** | Separates R2 (`step_index: 8 user_input` → `10 error_message`, `stdout-agy-f11893f7-1598-408d-acb9-baa4dd70842a.jsonl:3-5`) from PONG (`step_index: 4 user_input` → `7 agent_response`, no `error_message`, `r2-vs-ping-pong-compare.json:29-65`). | **PING** (`01-seed-ping-safe.json:53-81`, `r2-vs-ping-pong-compare.json:3-20`) and **v4 eligibility failure** (`01-cli-capture-v4-eligibility-on-resume.jsonl:42-43`). | PING is a genuine current-turn failure (`num_turns: 2`) that emitted `init` → `result(ERROR)` with **`steps: []`** (no `user_input` and no `error_message`). Requiring `error_message` would misclassify PING as non-error. |
| **R3: Require `AGY_ERROR` JSON on stderr (or `error_id` matching `<uuid>-<step_index>`)** | Present on R2 (`R2-CORRELATED-DESKTOP.md:23`) and mid-stream `streamGenerateContent` Bad Gateway (`01-cli-capture.jsonl:17`). | **PING** (`01-seed-ping-safe.json:43`, stderr only `error: timeout waiting for cascade to start running`) and **v4 eligibility failure** (`01-cli-capture-v4-eligibility-on-resume.jsonl:42`). | Genuine executor-construction / cascade-timeout and eligibility errors do not emit `AGY_ERROR` on stderr. Also `AntigravityJsonlTranslator` (`src/agent/antigravity/jsonl.ts:68-86`) is a pure stdout JSONL translator without stderr stream coupling. |
| **R4: Treat `result.status === "ERROR"` as historical if `result.response` is non-empty and/or exit code is `0`** | Separates PONG (`has_response: true`, `exit: 0`, `01-anomaly-for-agy.json:80-90`) from PING/R2 (`has_response: false`, `exit: 3`). | **Spec D1 & Brief line 15 prohibition** (`docs/specs/run-terminal-truth.md:17`, `AGY-TICKET02-BRIEF.md:15`); multi-step turn that streams partial `agent_response` delta before a real current-turn tool/model failure. | Forbidden heuristic. `AntigravityJsonlTranslator` emits terminal event upon seeing `event: "result"` before process exit (`src/agent/runner/jsonl-cli-runner.ts`), and non-empty text does not prove no current-turn error occurred after early text deltas. |
| **R5: Compare `result.error` string against prior turn's `result.error` string** | PONG's `result.error` is byte-equal to PING's (`01-anomaly-for-agy.json:47,78`). | Two consecutive turns hitting the **same real error** (e.g., repeated `MODEL_PLACEHOLDER_M418`, repeated `Bad Gateway`, or repeated `FAILED_PRECONDITION` location 400 on retry). | Suppressing an identical error string on turn $N+1$ would silently swallow genuine repeated failures on consecutive turns. |
| **R6: Use bridge `runId` or incrementing `result.num_turns`** | `num_turns` increments `1 → 2 → 3 → 4` (`01-seed-ping-safe.json`, `R2-CORRELATED-DESKTOP.md:31`). | **PONG** (`num_turns: 3`, `runId: 288d45af-…`) carries PING's error despite new `runId` and incremented `num_turns`. | `runId` identifies process stdout capture; `num_turns` identifies turn index in the conversation, not which turn produced `result.error`. |

---

## 3. Minimal Safe Product Rule for Ticket 02: **Do Not Implement**

Per Spec D2 (`docs/specs/run-terminal-truth.md:18`) and `issues/02-turn-attribution.md:5`:
> *"If 01 shows no reliable current-turn marker, do not implement; write the finding to delivery notes and stop."*

- **Recommendation:** **Do not implement** a product patch or heuristic in `src/agent/antigravity/jsonl.ts` for Ticket 02.
- Any stdout-only or stderr-assisted rule based on the currently available `agy 1.5.3` fields either:
  1. Fails to clear sticky historical errors on resumed turns (current behavior), **or**
  2. Relies on heuristics (`has_response` / exit `0` /absence of `error_message` / string dedupe) that either violate Spec D1 or misclassify genuine current-turn errors (such as PING's zero-step `MODEL_PLACEHOLDER_M418` error or multi-step partial-response errors) as successes.

---

## 4. Open Uncertainty & Recommended Minimal Next Gate

### Open Uncertainties
1. **Uncollected `step_update` sequence on `streamGenerateContent` Bad Gateway sticky repro (`01-sticky-probe.jsonl` / `01-cli-capture.jsonl`):**
   - The CLI probe scripts in `01-sticky-probe.jsonl` and `01-cli-capture.jsonl` logged `init` and `result` summaries (and `stderr` in `v3`/`v5`/`v6`), but did not record the full `step_update` lines (`user_input`, `agent_response`, `error_message`) for `procA` Turn 2 (`Bad Gateway`) vs `procB` Turn 3 (`PONG-01` with sticky `Bad Gateway`).
   - Even if `procA` Turn 2 had emitted `step_type: "error_message"` and `procB` Turn 3 had not, **PING** (`stdout-agy-10a55686-e56d-463c-9d8e-934d73ff4569.jsonl`, `r2-vs-ping-pong-compare.json:10`) already proves that a genuine current-turn error in `agy 1.5.3` can emit `steps: []` (zero `step_update` lines) before `result: ERROR`.
2. **Mid-turn failure after early `agent_response` delta:**
   - Whether `agy 1.5.3` populates `result.response` (non-empty) alongside `result.status: "ERROR"` and `step_type: "error_message"` when a turn streams initial `agent_response` text, invokes a tool, and then fails on the post-tool model request.
3. **Upstream CLI state persistence (`agy 1.5.3`):**
   - `agy 1.5.3` persists conversation error state in its internal session DB such that resuming a conversation after a mid-session error re-emits the historical `error` and `status: "ERROR"` in `result` even when the new turn completes normally (`exit 0`).

### Recommended Minimal Next Gate
1. **Record Ticket 02 as blocked / no-op on the docs track (`delivery-notes/01.md` & `delivery-notes/02.md` / `issues/02-turn-attribution.md`):**
   - Document that `agy 1.5.3` does not provide a lossless per-turn error ownership field in `event: "result"` or `event: "step_update"`, and that Ticket 02 halts per Spec D2 rather than shipping an unsafe heuristic.
2. **If an architectural workaround or narrow compound rule is ever considered by the spec owner, require an explicit Spec D2 amendment first:**
   - For example, evaluating whether `(sawAgentResponseStep || hasNonEmptyResponse) && !sawErrorMessageStep && processExitCode === 0` is acceptable as an explicit, spec-sanctioned composite rule (noting that PING had `sawAgentResponseStep = false` and `exit != 0`, while R2 had `sawErrorMessageStep = true` and `exit = 3`, and PONG had `sawAgentResponseStep = true`, `sawErrorMessageStep = false`, and `exit = 0`), **or** whether the bridge should rotate/discard poisoned `resumeHandle` sessions after a terminal `ERROR` rather than resuming a sticky-error conversation ID. Neither may be implemented without an explicit spec decision.
