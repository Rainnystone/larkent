# A8: Agent kind — fresh-session run and result post

**What to build:** kind=agent fires run the profile's agent in the cwd snapshot, scope `auto:<id>:<fireAt>`, fresh session started immediately (bypasses the process pool, no concurrency cap, never fails or waits for pool-full), never merged with human messages; overlapping fires allowed; one result post via Outbox (no typing/stream/CoT), follow-up thread continues that fire's session; `skip-cli-already-sent` respected; never uses Continuations. Gated by `automations.agentKind` (default off).

**Blocked by:** A2, A3

**Status:** ready-for-agent

- [ ] Fire during a human run: both proceed; group session gets no automation content.
- [ ] With the process pool full of human runs, a fire still starts at once and posts its result.
- [ ] Two overlapping fires of one task both produce their own result post.
- [ ] Interrupted fire posts a failure notice with no 继续 option and no auto-resume.
- [ ] Thread reply under a result post resumes that fire's session (normal group).
