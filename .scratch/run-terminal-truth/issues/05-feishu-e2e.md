# 05: Feishu E2E (Bot Arena)

**Blocked by:** 02, 03, 04, 06, 07, 08, 09 · **Status:** blocked · **Operator:** Orchestrator

Test bridge only; account 「Agent测试专员」; prefix 【端到端测试】.
- [ ] Recoverable upstream error then success: no failure tail, no 继续 card, no duplicate reply, typing cleared.
- [ ] Simulated reconnect + >2 min model silence within normal idle: run not killed early.
- [ ] A real tool silent past 15 minutes (e.g. a long shell sleep) is not killed at normal idle and finishes; model talk during it does not cut its grace.
- [ ] A model-only silent hang stops at normal idle with "waiting budget used up" wording, the timer name and awake minutes; no duplicate failure text.
- [ ] A document-comment task follows the same budgets as chat.
- [ ] Restore test bridge afterwards.
