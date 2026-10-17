# A6: Natural-language creation

Spec: [../../automations.md](../../automations.md) §3

**What to build:** @bot “10 分钟后/每个工作日 9 点…” → the agent emits a structured proposal (kind, schedule, task text); the bridge ignores any chat/scope/creator in it, validates, converts relative input to absolute, and reuses the A0d confirm card or the A2 scripted end card. The agent reply is shown with the proposal stripped.

**Blocked by:** A2

**Depends on #47:** soft (high conflict) — stripping the proposal sits on the bridge-owned final-reply path that #47 reroutes through the Outbox; build it after #47 merges to avoid redoing it.

**Status:** ready-for-agent (prefer after #47)

- [ ] Relative input is stored as an absolute instant identical to the card.
- [ ] Agent reply is shown with the proposal stripped; delivered once.
- [ ] Proposals from bot messages or inside automation runs never create drafts.
