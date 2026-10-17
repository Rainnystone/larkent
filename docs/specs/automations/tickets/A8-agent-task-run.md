# A8: Agent task — fresh-session run and result post

Spec: [../../automations.md](../../automations.md) §4, §5, ADR-005/006/011/013/019/020

**What to build:** agent-task fires run the profile's agent in the stored cwd snapshot, scope `auto:<id>:<fireAt>`, fresh session started immediately (bypasses the process pool, no cap, never fails or waits on pool-full), never merged with human messages; overlapping fires allowed; one result post via the Outbox (no typing/stream/CoT) with a "在本消息话题里追问" footer. For a catch-up, the result post says "补跑，原定 HH:MM", the prompt gets a one-line lateness hint, and a separate catch-up entry goes to the automations log (ADR-019). The follow-up thread continues that fire's session; `skip-cli-already-sent` is respected; never uses Continuations. Gated by `automations.agentTasks` (default off).

**Code anchors (master@d056198):**
- **New executor path.** `RunExecutor.submit` rejects with `reconnect-in-progress` while new runs are paused (src/runtime/run-executor.ts:89) and acquires from the process pool, failing `pool-full` (:100-109). ADR-011 says fires never go through the pool. Decide and test what a fire does while runs are paused (link down means the fire is not started; see A1').
- **Startup reaping.** Exclude `auto:` scopes from the startup orphan reaping → Continuation offer / interruption-notice path (`onInterrupted`, src/bot/channel.ts:573-616; called from `reapOrphansOwned`, src/bot/turn-journal.ts:564-613). An interrupted fire posts a plain failure notice with no 继续.
- **Hard timeout** = `DEFAULT_RUN_IDLE_TIMEOUT_MINUTES = 15` (src/config/schema.ts:309; resolver :317-321).
- **Thread follow-ups.** `scopeFor` maps a normal-group reply to the chat scope and a topic-group reply to `chatId:threadId` (src/bot/scope.ts:17-28). Add a mapping from the result post's root message → `auto:<id>:<fireAt>` so replies under it resume that fire's session in both group types.

**Blocked by:** A1', A2

**Status:** ready-for-agent

- [ ] Fire during a human run: both proceed; the group session gets no automation content.
- [ ] Pool full of human runs: the fire still starts at once and posts its result.
- [ ] Two overlapping fires of one task each produce their own result post.
- [ ] Interrupted fire posts a failure notice with no 继续 option and no auto-resume; restart does not offer a Continuation for it.
- [ ] Thread reply under a result post resumes that fire's session (normal group and topic group).
- [ ] Catch-up agent fire posts once with "补跑，原定 HH:MM" and writes one catch-up log entry; a later wake for that fire key is silent.
