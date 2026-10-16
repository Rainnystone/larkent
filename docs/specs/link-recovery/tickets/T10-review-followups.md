# T10 — Review follow-ups (fix alongside the Codex review of the code PR)

Spec: [../../link-recovery.md](../../link-recovery.md) · Blocked by: T0–T8 (code track) · Found in a read-only audit of the code branch head `bb4142b`.

Each item lands as its own commit on the code branch, starting with a failing test that asserts what the chat receives.

## 1. Interruption notice buttons depend on a leftover toggle

- **Problem.** `profile.reliability.notice` still exists and defaults off. Notice paths pass `noticeAuth` only when it is on, so by default the 继续 / 暂不 buttons are most likely not signed and do nothing; only typing 继续 works. This contradicts spec §7 (button or typed 继续 resumes) and §8 (no match-master toggles remain).
- **User scenario.** A run is interrupted by an outage; the user taps 继续 on the notice card and nothing resumes.
- **Proposed fix.** Remove the toggle (or make the only behaviour "on"), so every continue notice carries signed button actions. Old profiles containing the key load and save without it.
- **Acceptance.** With a default profile, an interruption renders a notice whose 继续 click resumes exactly once (card → 已继续) and a second click says 此继续已失效. Verified by actually rendering the card (recording channel test plus one real-Feishu check in the test bridge), not by reading code.

## 2. Redelivery skips the "agent already sent" check

- **Problem.** The normal reply path skips the bridge final reply when the agent already IM-sent to the chat (`outbound.skip-cli-already-sent`). `TurnJournal.redeliver` → `resendJournalReply` has no equivalent check.
- **User scenario.** The agent posts its answer through the CLI, then the bridge's own final reply fails during an outage; after recovery the bridge posts the answer again.
- **Proposed fix.** Record "agent already sent to this chat" on the staged turn and apply the same skip in redelivery (mark delivered instead of resending).
- **Acceptance.** Test: CLI send succeeds, bridge final send fails, recovery runs → the chat holds exactly one answer and the turn is `reply-delivered`.

## 3. Remove the leftover `lastBackfillEnd`

- **Problem.** The backfill window no longer uses `lastBackfillEnd` (spec §3), but the ledger still writes it.
- **User scenario.** None (maintenance): dead state invites someone to start using it again.
- **Proposed fix.** Stop writing it; the loader ignores the old field (schema stays v1).
- **Acceptance.** No reads or writes of `lastBackfillEnd` remain outside the loader's tolerance; an old `backfill-state.json` containing it loads and saves cleanly.

## 4. Silent-drop edges: fix or declare

Each is either fixed or listed under spec "Known limitations"; none may stay silent.

| Edge | User scenario | Proposed handling | Acceptance |
|---|---|---|---|
| Outage longer than `lookbackMs` (default 6 h) | Host asleep overnight; messages older than 6 h before wake are never answered | Fix minimally: when `until − since > lookbackMs`, log `backfill.window-truncated` and post one short notice per affected chat ("消息可能有遗漏，请重发") — or, at least, log and declare | Test with a 7 h outage: the log line appears (and the notice, if adopted) once per recovery, not per message |
| @bot inside a thread reply in a normal (non-topic) group | Reply in a thread during the outage is not recovered (chat container returns only roots) | Declare as a known limitation | Spec lists it; `backfill.topic-partial` stays logged |
| First-contact DM with no prior session | First DM sent while down is never answered | Declare | Spec lists it |
| Processed ledger pruned (12 h) or lost | A message can be answered a second time if it reappears in a later window | Declare | Spec lists it |

Also correct the user-visible contract in the spec ("exactly one reply or one notice") to reference these limits.
