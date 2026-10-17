# A6: Natural-language creation

Spec: [../../automations.md](../../automations.md) §3

**What to build:** @bot “10 分钟后/每个工作日 9 点…” → the agent emits a structured proposal (task type, schedule, task text); the bridge ignores any chat/scope/creator in it, validates, converts relative input to absolute, and reuses the A0d confirm card or the A2 scripted end card. The agent reply is shown with the proposal stripped, on the existing bridge-owned final-reply path (Outbox-staged on master).

**Blocked by:** A2

**Status:** ready-for-agent

- [ ] Relative input is stored as an absolute instant identical to the card.
- [ ] Agent reply is shown with the proposal stripped; delivered once.
- [ ] Proposals from bot messages or inside automation runs never create drafts.
