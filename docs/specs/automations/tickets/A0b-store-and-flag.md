# A0b: Automations store, settings, automations log, glossary

Spec: [../../automations.md](../../automations.md) §1 (automation id, fire key, started, automations log), §2, §3, §9, ADR-016/017/019/020

**What to build:**

- Per-profile automations file (`schemaVersion: 1`, atomic write, supervisor-owned like the turn journal, survives `/reconnect` and bridge swap). Items: per-profile **auto-increment short `id`, never reused**, `taskType` (`reminder` | `agent`; not `kind`, which CONTEXT already uses for `AgentKind`, CONTEXT.md:13), schedule, timezone, `startAt`/`endAt`, `nextFireAt`, `lastFireAt`, `paused`, `missed`, `lastStatus`, bounded fire history, and the creation-time fields: **chat binding**, **`createdBy`**, **name**, **task text** and, for agent tasks, the **cwd** captured at creation. The cwd has to be stored because today cwd is resolved per scope (`input.workspaces.cwdFor(input.scopeId) ?? profileConfig.workspaces.default`, src/bot/run-flow.ts:112), and `auto:` scopes have no workspace entry of their own. Also: the set of **started fire keys** persisted atomically before execution; the list of missed instants per item that the board shows as 已错过 for 24 h; drafts with 24 h TTL. A future `schemaVersion` is refused without overwriting; older code ignores the file.
- **Automations log**: a separate append-only local file in the profile data dir with one entry per missed instant and one per catch-up (id, task type, scheduled instant, decided-at, trigger source, result). Kept permanently: no truncation, not removed when the item expires or is deleted. No task text, no Feishu ID.
- Profile settings as a new **top-level `automations` block** with its own normalizer: `automations.enabled` (default off), `automations.agentTasks` (default off), `automations.timezone` (IANA, default `Asia/Shanghai`). It has to be a new normalizer: `normalizeProfile` builds the profile from explicit per-key normalizers (src/config/profile-schema.ts:320-334), so an unknown top-level key is dropped, and `normalizeReliability` drops the whole `reliability` block (src/config/profile-schema.ts:452-456), so the settings can't go there.
- Paths and atomic writes on Windows, macOS and Linux via `writeFileAtomic` (src/platform/atomic-write.ts:30; bounded Windows rename retry at :17-24, POSIX file + directory fsync at :47 and :57).
- **Glossary** in CONTEXT.md, in the same PR as the code: add **automation**, **agent task** (agent 任务), fire, fire key, catch-up, 已错过, automations log, scheduler; broaden **run** (CONTEXT.md:23, today "one invocation of an agent for one Feishu message") to "one Feishu message or one fire"; extend **bridge-owned final reply** (CONTEXT.md:78) to the agent-task result post; make clear the scheduler is not a recovery poller (CONTEXT.md:83). Rename `isCreator` → `isBotOwner` (src/policy/access.ts:40; call sites :115, :140, :155) so "creator" means only the automation's `createdBy`.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Flag off → bridge behaviour identical to baseline; no file created.
- [ ] `automations` settings survive a profile load/save round-trip; unset values read as the defaults above.
- [ ] Ids are monotonic across delete and restart (delete 3, create → 4).
- [ ] `markStarted(fireKey)` is durable before it returns; a second call reports already-started.
- [ ] Future schemaVersion → load refused, original file untouched.
- [ ] Automations log entries survive item deletion, expiry and fire-history pruning.
- [ ] Atomic-write tests pass on the Windows, macOS and Linux CI legs.
- [ ] No Feishu ID or secret is written to the status file or the automations log (the chat binding lives only in the automations file).
- [ ] `isBotOwner` rename: no `isCreator` left in `src/`; access tests unchanged in behaviour.
