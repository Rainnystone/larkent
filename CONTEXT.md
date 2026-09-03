# CONTEXT

Domain vocabulary for this repo. Use these words in code, tests, docs, and PR bodies. If a concept needs a new word, add it here in the same PR.

## What this is

A bridge that puts CLI coding agents behind Feishu/Lark bots. One machine (a VPS, or a Grok Bot cloud computer) runs one supervisor; the supervisor hosts any number of **profiles**; each profile is one Feishu bot backed by one **agent**.

Grok Bot is the deployment target (a SpaceXAI always-on teammate with its own cloud computer). It is not an agent. Grok Build is an agent, one of five, with no special standing.

## Agents

- **agent kind** (`AgentKind`): `claude`, `codex`, `kimi`, `grok`, `cursor`. Defined once in `src/agent/registry.ts`. Nowhere else lists them.
- **AgentDescriptor**: the record that fully describes one agent kind. Shared code reads descriptor fields; it never branches on the kind literal.
- **AgentRegistry**: ordered descriptors plus lookup. Adding an agent means one new adapter directory and one registry entry.
- **adapter** (`src/agent/<kind>/`): argv building, JSONL translation, model list, capability declaration, per-agent options schema. Knows nothing about Feishu.
- **JsonlCliRunner** (`src/agent/runner/`): spawns the CLI, streams stdout as JSONL, owns stderr, timeouts, abort, exit codes. The only place a CLI process is spawned.
- **translator**: pure function from one JSONL line to zero or more `AgentEvent`s. Each adapter exports one.

## Runs and sessions

- **run**: one invocation of an agent for one Feishu message.
- **run input** (`AgentRunInput`): prompt, cwd, optional resume handle, model, attachments, and an opaque `agentOptions` bag the descriptor validates.
- **resume handle**: the opaque string that continues a conversation. Codex's thread id and everyone else's session id are both resume handles. Shared code has no other name for it.
- **reply mode**: `stream-deltas` or `final-answer`. Declared on the descriptor; decides how the stream maps onto Feishu card updates.
- **session catalog** (`sessions.catalog.json`): per profile, maps Feishu threads to resume handles plus the policy fingerprint they were created under.
- **policy fingerprint**: SHA-256 over the inputs that decide whether a stored session may resume. Stability is a pinned contract.

## Profiles and runtime

- **profile**: one bot's on-disk configuration. Feishu app identity plus an `agent` block: `kind`, optional `binaryPath`, `options`.
- **supervisor**: one process hosting many profiles. Profiles are isolated: separate sessions, locks, registry entries.
- **process registry** and **runtime locks**: per-profile bookkeeping on disk so two supervisors do not fight over one profile.
- **preflight**: checks that the agent binary exists and answers; produces diagnostics shown by onboarding and `doctor`.

## Persistence rules

- Every persisted shape carries `schemaVersion`. Missing means 1.
- One loader per store; it upgrades old versions step by step, writes back, and returns the current shape. Code after the loader sees only the current shape.
- Upgrade steps live in `migrations.ts` next to the store and are deleted two minor releases after they ship.

## Words we do not use

- "default agent". There is none.
- "sessionId" or "threadId" outside an adapter or a migration.
- "built-in" versus "added" agents. All five are equal.
