# A8: Agent kind — fresh-session run and result post

Spec: [../../automations.md](../../automations.md) §4, §5, ADR-005/006/011/013

**What to build:** kind=agent fires run the profile's agent in the cwd snapshot, scope `auto:<id>:<fireAt>`, fresh session started immediately (bypasses the process pool, no cap, never fails or waits for pool-full), never merged with human messages; overlapping fires allowed; one result post via the Outbox (no typing/stream/CoT), "在本消息话题里追问" footer and, for a catch-up, "原定 HH:mm" plus a one-line lateness hint in the prompt; follow-up thread continues that fire's session; `skip-cli-already-sent` respected; never uses Continuations. Hard timeout equals #47's default idle bound. Gated by `automations.agentKind` (default off).

**Blocked by:** A1', A2

**Depends on #47:** hard — result post via the Outbox, the default idle bound and the "no Continuations" rule are #47 contracts.

**Status:** blocked (#47)

- [ ] Fire during a human run: both proceed; the group session gets no automation content.
- [ ] Pool full of human runs: the fire still starts at once and posts its result.
- [ ] Two overlapping fires of one task each produce their own result post.
- [ ] Interrupted fire posts a failure notice with no 继续 option and no auto-resume.
- [ ] Thread reply under a result post resumes that fire's session (normal group).
- [ ] Catch-up agent fire posts once with "原定 HH:mm"; a later wake for that fire key is silent.
