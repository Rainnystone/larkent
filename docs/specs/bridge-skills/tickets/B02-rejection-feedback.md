# B02 — Automations skill: machine-usable rejection feedback to the model on the next turn

Status: ready-for-agent · Blocked by: B01 · Skill: `automations` · Track: code branch `feat/bridge-skills` (refs verified at `953e7bd`) · One ticket per session

## What to build

When the bridge rejects an automation proposal, the model learns exactly why on its next turn in that scope and how to fix it, so it does not repeat `every 1d` three times. Today the rejection line reaches the group, but the resumed agent transcript only holds the model's own output, so the model has no reliable, machine-usable signal. Build the record / inject mechanism generically for reply-directive bridge tools (keyed by tool name); `automation-proposal` is its first user.

1. **Reason codes everywhere.** Every non-success verdict carries a stable reason code (Spec D5): schedule reasons already do; `refuse` gains a code (`p2p-only`, `agent-tasks-disabled`, `agent-needs-cwd`, `cannot-save`) with unchanged user-facing text; `unknown-id` keeps its code. `auto.rejected` logs use the same code set (keep the existing `rejectLogReason` grouping only if a log consumer depends on it; otherwise log the code).
2. **Record.** On a rejected proposal (reject, refuse, unknown-id), record per scope: tool `automation-proposal`, `op`, reason code, the model's schedule text or id. Memory only (Q8 default). A newer rejection overwrites; a successful proposal clears it.
3. **Inject once.** On the next human-triggered run in that scope, inject one structured block as a turn fact in `bridge_instructions` (so after the catalog and before `user_input`), for example:

   ```
   <bridge_tool_rejected tool="automation-proposal" skill="automations" op="create" reason="invalid-schedule">
   input: every 1d 09:00 until <date>
   fix: <the recovery entry for invalid-schedule, copied from SKILL.md>
   </bridge_tool_rejected>
   ```

   The `fix` text comes from the skill module's **read skill** entry, then the recovery entry for that reason code (single source of truth; the model gets the fix even if it never opened the file). No second reader of `SKILL.md`. Consumed after injection. `auto:` / `meeting:` runs neither see nor consume it. If **read skill** returns nothing this turn (the skill is gated), drop the record.
4. Input text is untrusted model output: escape it the same way the group snapshot escapes fields, and keep it under a length cap.

## Source (953e7bd)

- Verdict type `src/automations/command.ts:116`; `assessAutomationProposal` `:125`; `planCreateProposal` / `planReplaceProposal` / `planDeleteProposal` (`:205-270`) return `refuse` with message constants.
- Settle path where the verdict is computed and rejections are logged: `src/bot/channel.ts:2650-2680` (`automationProposalSuffix`, `noteAutomationRejected`, unknown-id log).
- Turn prompt assembly and the catalog from B01: `src/bot/channel.ts:1836-1860`; `continuations.take` at `:1838` is prior art for per-scope one-shot prompt state.
- Snapshot escaping: `snapshotField` / `escapeSnapshot` in `src/automations/proposal.ts`.

## Acceptance criteria

- [ ] Integration (`startChannel` + `FakeAgentAdapter`, prior art `tests/integration/bot/auto-proposal-reply.test.ts`): turn 1 the fake agent proposes `every 1d 09:00 until …`; the group gets the rejection line and no confirm card. Turn 2 (new human message, same scope): the prompt contains the rejection block with `reason="invalid-schedule"`, the rejected input, and the `SKILL.md` recovery text for `invalid-schedule`.
- [ ] Turn 3 in the same scope: the block is gone (consumed once).
- [ ] A successful proposal after a rejection clears it; a second rejection replaces the first (only the latest appears).
- [ ] A different scope (another group) never sees it; an `auto:` fire in the same chat does not consume it; after `automations.enabled` is turned off, the record is dropped, not injected.
- [ ] Refuse paths carry codes: agent proposal with `agentTasks` off → block says `agent-tasks-disabled`; delete of an id not in this group → `unknown-id`. User-visible refusal text is unchanged (existing tests stay green).
- [ ] Unit: every reason code the verdict can carry maps to a `SKILL.md` recovery entry (reuses B01's contract test; extend it to the new refuse codes).
- [ ] Injected input is escaped and capped (a proposal whose schedule contains `</bridge_tool_rejected>` cannot close the block).
- [ ] `pnpm ci:local` passes in the worktree.

## Out of scope

Automatic retry runs (Q3). Persisting feedback across restart (Q8). Rejection line wording (B03).
