# 01: Capture redacted raw terminal result

**Blocked by:** None · **Status:** ready-for-agent

Spec D1. In the antigravity jsonl adapter, when a terminal `result` line arrives, log at info (`phase:'agent'`, `event:'terminal-result'`) its status, error code/type, error message first 200 chars with secrets/tokens redacted, and any per-turn/session identifiers the CLI provides. No message body. Unit test: ERROR and SUCCESS results produce the log with redaction.

Then on the **test bridge** reproduce: in a fresh test session make the CLI hit a recoverable upstream error, then send a follow-up that succeeds. Record in delivery notes whether the follow-up's raw result carries the old error and which field could mark the current turn.

## Acceptance
- [ ] Red then green; `pnpm ci:local` green.
- [ ] Delivery note answers: does a historical error appear in a later turn's result? Which field identifies the current turn (or none)?
