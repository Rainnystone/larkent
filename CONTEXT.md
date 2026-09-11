# CONTEXT

Domain vocabulary for this repo. Use these words in code, tests, docs, and PR bodies. If a concept needs a new word, add it here in the same PR.

## What this is

Larkent connects CLI coding agents to Feishu/Lark bots. It is inspired by [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) and has been refactored around a shared multi-CLI runtime. A host can run a **profile** in the foreground (`run`), as a per-profile service (`start`), or under a supervisor console (`run --web-ui` / `start --web-ui`). The console starts the active profile and can host other profiles on demand. Each profile is one Feishu bot backed by one **agent**.

Deployment hosts are separate from agent kinds. Claude Code, Codex CLI, Kimi Code, Grok Build, Cursor CLI and Antigravity CLI are equal agents; the project is not tied to one deployment product.

## Agents

- **agent kind** (`AgentKind`): `claude`, `codex`, `kimi`, `grok`, `cursor`, `antigravity`. Derived from the descriptor tuple in `src/agent/registry.ts`, the single production registration source. Tests may independently list the registered kinds to detect drift.
- **AgentDescriptor**: the record that fully describes one agent kind. Adapter-owned metadata, factory, binary detection, options, capabilities and history access. Shared creation, capability, detection and UI entry points consume the registered descriptors.
- **AgentRegistry**: the registered descriptor tuple, derived ordered kinds and lookup (`AGENT_REGISTRY`). Detection order is derived from each descriptor's explicit priority. Adding an agent means one new adapter directory and one registry entry.
- **adapter** (`src/agent/<kind>/`): argv building, JSONL translation, model list, capability declaration, per-agent options schema. Knows nothing about Feishu.
- **JSONL process runner** (`runJsonlCli`, `src/agent/runner/`): shared implementation for agent run subprocesses, stdout/stderr, exit, stop and cleanup. Optional signal/timeouts belong to this runner API; production business idle remains in the bot. Binary probes and history queries have their own adapter-owned calls.
- **translator**: a **per-run** object with `translate(line)`, `finish()`, and `fail(error)`. It may hold session, pending text, and tool-call state. It is not a shared pure function on the descriptor. Each adapter run constructs a fresh translator and passes it to the runner.

## Runs and sessions

- **run**: one invocation of an agent for one Feishu message.
- **run options** (`AgentRunOptions`): run id, prompt, cwd, optional resume handle, model, images and adapter options. The executor maps the run's effective access into validated options; the profile adapter receives its bot identity through `setBotIdentity`.
- **resume handle**: the opaque string that continues an **agent** conversation. Codex's thread id and everyone else's session id are both resume handles. Shared agent code has no other name for that handle.
- **reply mode**: `stream-deltas` or `final-answer`. Declared on the descriptor; decides how the stream maps onto Feishu card updates.
- **session catalog** (`sessions.json.catalog.json`, that is `${sessionsFile}.catalog.json`): per profile, maps Feishu scopes to resume handles plus the policy fingerprint they were created under.
- **policy fingerprint**: SHA-256 over the inputs that decide whether a stored session may resume. V2 stability is a pinned contract.

## Profiles and runtime

- **profile**: one bot's on-disk configuration. Feishu app identity plus an `agent` block: `kind`, optional `binaryPath`, `options`.
- **runtime ownership**: each profile owns its adapter instance, identity, session state and active runs. Each run owns its subprocess and translator state. Shared working directories and existing CLI login environments are allowed; this is not filesystem or account isolation.
- **supervisor**: hosts profile runtimes with separate sessions, locks and process registry entries.
- **settlement**: the executor retains scope/active-run ownership until child exit and adapter cleanup succeed. A terminal event alone is not settlement. `stop()` rejects on settlement failure; profile shutdown waits for consumers and store flushes and reports failures.
- **process registry** and **runtime locks**: per-profile bookkeeping on disk so two supervisors do not fight over one profile.
- **preflight**: checks that the agent binary exists and answers. Onboarding uses `detectInstalledAgents`. The in-chat `/doctor` command is a per-profile echo, not a CLI.

## Persistence rules

- Profile documents use `schemaVersion: 3`, including `agent.kind`, optional `agent.binaryPath` and `agent.options`. The session catalog uses v2.
- SessionStore uses v2 `{ schemaVersion, entries }`; entries use `resumeHandle`, preserve cwd/timestamps and allow idle-only preferences. The loader upgrades the legacy unversioned scope map and its `sessionId`.
- WorkspaceStore uses v2 `{ schemaVersion, chats, named }`, preserving chat and named workspace mappings. Its loader upgrades legacy v1 documents.
- Loaders validate supported formats, atomically persist required upgrades and expose the current shape. Unsupported future versions are rejected without replacing the original. Store flush and shutdown propagate persistence failures.
- New-profile bootstrap resolves binary env settings into `agent.binaryPath`; stored profile paths take precedence afterward. Bridge data roots do not replace `HOME` or CLI login state.
- A code rollback does not downgrade data. Restore matching data backups before running an older version.

## Self-heal and backfill

Design: [docs/specs/wake-up-backfill.md](docs/specs/wake-up-backfill.md).

- **self-heal**: recovery the bridge performs on its own after a disconnect, sleep, freeze or restart. No external watcher, poller or host routine is assumed. Lives in `src/bot/`, identical for every profile and agent kind.
- **recovery signal**: an event that may mean messages were missed: a successful `channel.connect()` inside `startChannel` (covers keepalive wake-up → `controls.restart()`, `/reconnect`, `/account`, process start) or the SDK's `reconnected` event.
- **backfill**: the idempotent catch-up routine that runs on a recovery signal: pull recent group history with **bot identity**, keep messages that @-mention this bot and are not in the processed ledger, and hand them to the normal `intakeMessage` path. Not a poller; it never runs on a timer.
- **live watermark** (`lastLiveAt`): the last keepalive tick that observed the WS in `connected` state, persisted per profile. The backfill window starts at the watermark minus a fixed margin and is capped by `lookbackMs`.
- **backfill window**: `[max(now − lookbackMs, min(lastLiveAt, lastBackfillEnd) − margin), now]`. A missing watermark initializes it without scanning.
- **processed ledger** (`backfill-state.json`, schema v1): per-profile store of processed `message_id`s plus the watermarks. Owned by the supervisor per profile and injected into `startChannel` like `sessions`, so it survives `controls.restart()`.
- **claim**: the synchronous check-and-reserve of a `message_id` at `intakeMessage` entry. Released if the message is gated out, recorded as processed once it is accepted (queued or handled as a command).
- **backfill mark**: bridge-side note that a queued message came from backfill; `runAgentBatch` turns it into one lateness hint in the prompt. `NormalizedMessage` is not extended.

## Words we do not use

- "default agent". There is none.
- "poller" or "patrol" for recovery. Backfill runs on recovery signals, never on a schedule.
- Agent resume fields named `sessionId` or `threadId` outside an adapter or a migration. Shared agent code says `resumeHandle`.
- "built-in" versus "added" agents. All registered kinds are equal.

Existing CLI/card/history DTO fields may retain their specified protocol names; the current SessionStore memory and disk fields use `resumeHandle`. Feishu routing still uses protocol `thread_id` / `threadId` in `src/bot/scope.ts` and the channel SDK. QR onboarding still uses a Feishu `sessionId`. Those are not resume handles. Do not rename them.
