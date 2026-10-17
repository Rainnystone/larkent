# A11: E2E in Bot Arena (controller-owned)

Spec: [../../automations.md](../../automations.md) Testing Decisions

**What to build:** run the isolated test bridge in Bot Arena with a fake clock or test-only floor override (never a production “1 分钟后” input): create → scripted end card → confirm → fire → reminder; stop the bridge across two instants, restart → one catch-up with "补跑，原定 HH:MM", one 已错过 row + one missed notice for the older instant, automations log entries present; local wake for the same fire key → silent; agent-task fire → result post → thread follow-up; board pin, re-pin after manual unpin, Pause/Delete taps by a second member; status block read by the read-only monitor app (id/paused/updatedAt present); bot removed. Owned by the controller, not a cloud agent.

**Blocked by:** A0a–A10

**Status:** ready-for-human

- [ ] Each scenario has redacted evidence (no IDs, no secrets).
- [ ] Button callbacks verified with a real tap.
- [ ] Test messages unpinned and recalled afterwards.

## Notes from the first A11 run (2026-10-18, code `a27e564`)

- **`/auto` commands cannot be sent by the E2E executor.** E2E test messages must start with the 【端到端测试】 prefix, but the bridge only parses a slash command when the content starts with `/`, so a prefixed `/auto new …` is treated as chat. The executor therefore creates tasks via natural language only. Any scenario that needs a literal `/auto …` command (`/auto new`, `/auto`, `/auto pause|resume|delete <id>`) is sent **by the orchestrator from the desktop** (real user, no prefix), and each such message is listed in the evidence and recalled afterwards.
- **Card taps are done by the orchestrator via the desktop.** The executor cannot tap Feishu cards. Confirm 「是/否」, end-time presets and custom date submit, and board Pause/Resume/Delete (including the second-member tap) are performed by the orchestrator in the desktop Feishu client; the executor records the resulting log/store/status evidence. In the first run no card could be tapped because no card was ever posted (A13), and drafts were promoted to items by a store edit while the bridge was down — that does **not** count as a callback check.
- Findings filed from this run: [A13](A13-cards-schema2.md) (blocker: automation cards are schema 1.0 and fail `cardkit.v1.card.create` with 200610), [A14](A14-agent-result-body.md) (high: agent result posts drop `finalText`), [A15](A15-notice-wording-and-trigger-source.md) (minor: cross-day 原定 labels, `triggerSource`, no follow-up footer on interrupted/policy-guard notices). Rerun the scenarios each ticket lists after it lands.
- Cross-group posting could not be exercised for real: the test bot is only in Bot Arena. A probe to a fabricated chat id returned 230001 and nothing landed elsewhere.
