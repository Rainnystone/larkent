# A6: Natural-language creation

**What to build:** @bot “10 分钟后/每个工作日 9 点…” → agent emits a structured proposal (kind, schedule, text); bridge ignores chat/scope/creator in it, validates, converts relative input to absolute, and reuses the A1/A2 confirm or scripted-card flow.

**Blocked by:** A2

**Status:** ready-for-agent

- [ ] Relative input is stored as an absolute instant identical to the card.
- [ ] Agent reply is shown with the proposal stripped.
- [ ] Proposals inside automation runs never create drafts.
