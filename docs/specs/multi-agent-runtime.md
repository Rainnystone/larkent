# Spec: Multi-agent runtime (five equal CLI agents, N independent Feishu bots)

Status: approved design brief, ready for pstack `multi-phase-plan`.
Owner: Rainnystone. Written 2026-09-03 from the architecture review (`Arch_review_findings.md` in the parent vault).

This document is the input to pstack. pstack writes its own phase plan from it. Do not treat the PR sequence below as the plan; treat it as the shape the plan must satisfy.

---

## 1. Goal

One bridge codebase runs any number of Feishu/Lark bots on one machine. Each bot has its own profile, its own Feishu app identity, and its own CLI coding agent behind it. The five supported agents are peers:

| kind | CLI | JSONL flag today |
|---|---|---|
| `claude` | Claude Code | `--output-format stream-json` |
| `codex` | Codex CLI | `exec --json` |
| `kimi` | Kimi Code | `--output-format stream-json` |
| `grok` | Grok Build | `--output-format streaming-json` |
| `cursor` | Cursor CLI (`agent`) | `--output-format stream-json` |

No agent is the default. No agent is the special case. Adding a sixth agent touches one directory plus one registry line.

### Non-goals

- Changing anything a Feishu user can observe: card layout, slash commands, thread and topic semantics, mention handling, permission prompts, history. Section 3 pins this.
- Keeping merge compatibility with upstream `lark-channel-bridge`. This repo is a hard fork from here on.
- Supporting agents that do not speak newline-delimited JSON over stdout. The runner is JSONL only.
- Back-compat shims that outlive one release. State upgrades are one-shot and forward only (section 6).

---

## 2. Vocabulary

Defined once in `CONTEXT.md` at the repo root. Code, tests, and PR bodies use these words and no synonyms.

- **agent kind**: one of the five string literals. Type `AgentKind`. Lives in exactly one place, the registry.
- **AgentDescriptor**: the immutable record that fully describes one agent kind. Everything shared code needs to know about an agent comes off its descriptor, never off an `if (kind === ...)`.
- **AgentRegistry**: the ordered list of descriptors plus lookup by kind. The single source of truth for "which agents exist".
- **adapter**: the per-agent directory `src/agent/<kind>/`. Owns argv building, JSONL event translation, model list, capability declaration. Knows nothing about Feishu.
- **JsonlCliRunner**: the one module that spawns a CLI, streams stdout as JSONL, handles stderr, timeouts, abort, exit codes, and hands parsed lines to the adapter's translator.
- **resume handle**: the opaque string an agent needs to continue a conversation. Codex calls it a thread id, everyone else a session id. Shared code sees one field: `resumeHandle`.
- **reply mode**: how an adapter's stream maps onto a Feishu reply. Either `stream-deltas` (text arrives incrementally) or `final-answer` (one terminal message). Declared on the descriptor.
- **profile**: one bot's configuration on disk. Holds the Feishu app identity and the `agent` block (kind, binary path, per-agent options).
- **policy fingerprint**: SHA-256 over the inputs that decide whether a stored session may resume. Same inputs must keep producing the same hash (section 3).
- **run options**: what shared code passes to an adapter for one run. Split into shared fields and an opaque `agentOptions` bag the descriptor owns.

---

## 3. Behavior contracts to pin before touching anything

These are the observable behaviors that must be byte-for-byte or semantically identical before and after. The first PR adds a test for each that fails on any drift. Later PRs may not weaken these tests.

P1. **Feishu surface parity.** For each of the five kinds, a fake CLI (`tests/helpers/fake-executable.ts`, extend to emit a scripted JSONL stream) driven through the bot produces the same sequence of channel calls (card create, card update, final message, error card). Golden files per kind under `tests/static/` or `tests/integration/bot/`. Parameterize one test over all five kinds; do not write five tests.

P2. **Resume continuity.** A session started under the current code with a stored `sessionId` (four kinds) or `threadId` (codex) must still resume after upgrade. Fixture files use the deployed catalog name `sessions.json.catalog.json` (that is `${appPaths.sessionsFile}.catalog.json`). Old-shape fixtures are committed as test data and must load and resume.

P3. **Policy fingerprint stability.** `tests/unit/policy/fingerprint.test.ts` gains golden hashes for representative `FingerprintInputV2` values for all five kinds, including a codex input with `codexHome` and `inheritCodexHome`. Hashes must not change. The catalog stores only the digest, not the inputs, so a V3 re-fingerprint of stored sessions is impossible and is forbidden. Keep `FingerprintInputV2` byte-stable.

P4. **Profile load parity.** Existing profile directories (fixtures for all five kinds, including the current three binary path conventions) load to the same effective runtime configuration.

P5. **Slash command parity.** Pin the commands that exist today. `src/commands/index.ts` registers `/resume` and `/status`. It does not register `/history` or `/model`. Snapshot `/resume` and `/status` per kind. Also snapshot that `/history` and `/model` stay absent. Do not add those handlers in this program.

P6. **Multi-bot isolation.** One supervisor process with two or more profiles of different kinds: a mention in bot A's chat never reaches bot B's agent; sessions, locks, and registry entries stay per profile. This test likely exists in `tests/integration/runtime/`; extend it to cover all five kinds pairwise or at least two heterogeneous pairs.

P7. **Preflight and detection.** There is no `larkent` binary and no `doctor` CLI subcommand. Pin `detectInstalledAgents` in `src/cli/agent-detection.ts` (the onboarding PATH probe) and the in-chat `/doctor` handler in `src/commands/index.ts` (`handleDoctor`). For the same PATH and profile, detection found/missing must match the fixture. `/doctor` keeps its current per-profile echo behavior. Do not invent a CLI doctor in this program.

---

## 4. Target shape

### 4.1 Registry and descriptor

```ts
// src/agent/registry.ts
export const AGENT_KINDS = ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentDescriptor {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly binaryNames: readonly string[];      // candidates for PATH detection
  readonly capabilities: AgentCapability;       // existing type, made complete
  readonly models: readonly ModelOption[];
  readonly replyMode: 'stream-deltas' | 'final-answer';
  readonly resume: { flag: string; label: string }; // e.g. { flag: '--resume', label: 'session' } / { flag: 'resume', label: 'thread' }
  readonly buildArgv(run: AgentRunInput): string[];
  readonly createTranslator(): JsonlTranslator; // per-run instance; never a shared function
  readonly prepareRun?(run: AgentRunInput): Promise<JsonlPrepareResult>; // temp files, env
  readonly agentOptionsSchema: Schema;          // validates profile.agent.options for this kind
  readonly policyInputs(options: AgentOptions): Record<string, unknown>; // feeds fingerprint
  readonly mapEffectiveAccess(access: EffectiveAccess): unknown; // per-run sandbox / permissionMode
  readonly preflight?(binaryPath: string): Promise<PreflightDiagnostic[]>;
}

export interface JsonlTranslator {
  translate(line: string): AgentEvent[];
  finish(): AgentEvent[];   // Kimi emits its final event here
  fail(error: unknown): AgentEvent[];
}

export interface JsonlPrepareResult {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;  // always run, including on error
}

export const AGENT_REGISTRY: ReadonlyMap<AgentKind, AgentDescriptor>;
export function descriptorFor(kind: AgentKind): AgentDescriptor;
export function isAgentKind(value: unknown): value is AgentKind;
```

Rules:
- Every current `if (agentKind === ...)` chain and every hand-written union of the five literals is replaced by a descriptor field or `AGENT_KINDS`. Findings F1, F2, F3, F5, F6, F8, F11 in the review enumerate the sites. Target count of literal `'claude' | 'codex' | ...` unions outside the registry: zero. Verify with a static test in `tests/static/contracts.test.ts` that greps `src/` and `web/src/`.
- `web/src/lib/types.ts` imports `AgentKind` from a shared location or from generated output; it does not redeclare the union.
- The onboarding wizard lists `AGENT_KINDS` in registry order and preselects nothing (or preselects only what detection found). Grok is not pre-selected.
- No `claude` fallthrough anywhere. An unknown kind is a hard error at profile load with a message listing `AGENT_KINDS`.

### 4.2 JsonlCliRunner

```ts
// src/agent/runner/jsonl-cli-runner.ts
export interface JsonlCliRunnerInput {
  binaryPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  translator: JsonlTranslator;     // per-run instance from descriptor.createTranslator()
  cleanup?: () => Promise<void>;   // from prepareRun; runner always calls it
  signal: AbortSignal;
  timeouts: { idleMs: number; totalMs: number };
}
export function runJsonlCli(input: JsonlCliRunnerInput): AsyncIterable<AgentEvent>;
```

All five adapters use it. Each adapter shrinks to `argv.ts` (pure), a per-run translator class with `translate`/`finish`/`fail`, optional `prepareRun`/`cleanup`, and a descriptor export. No adapter spawns a process. Process tests in `tests/process/*-adapter.test.ts` become one parameterized suite driven by the registry plus per-kind JSONL fixtures. The three real smoke tests (`grok`, `kimi`, `cursor`) stay. Claude and Codex have no real smoke tests today. Do not add them in this program.

Claude's `stream-json.ts` and Codex/Kimi/Grok/Cursor `jsonl.ts` translators already hold session, pending text, and tool-call state. They move under `createTranslator()`. A descriptor-level shared function is forbidden because concurrent profiles would leak state and Kimi would drop its final event.

### 4.3 Events and resume

```ts
// src/agent/types.ts
export type AgentEvent =
  | { type: 'session'; resumeHandle: string }
  | { type: 'text-delta'; text: string }
  | { type: 'final'; text: string }
  | { type: 'tool'; ... }
  | { type: 'error'; ... }
  // no sessionId / threadId fields
```

Shared code (`run-flow.ts`, `comments.ts`, `commands/index.ts`, `channel.ts`, session catalog) stores and passes `resumeHandle` only. The adapter's `buildArgv` knows how to turn a handle into `--resume <id>` or `resume <id>`. `usesNativeSessionId` and `usesFinalAnswerReply` disappear in favor of descriptor fields.

### 4.4 Run options

```ts
export interface AgentRunInput {
  prompt: string;
  cwd: string;
  resumeHandle?: string;
  model?: string;
  attachments: Attachment[];
  botIdentity: AgentBotIdentity;   // per-profile openId and name; never on the shared descriptor
  effectiveAccess: EffectiveAccess; // per-run clamp from run-policy; not a static profile default
  agentOptions: unknown;   // validated by descriptor.agentOptionsSchema at profile load
}
```

`CodexSandboxMode`, `ClaudePermissionMode`, `codexHome`, `inheritCodexHome` and any future per-agent knobs live inside `agentOptions` and inside the owning adapter. Shared code never names those types. The per-run access clamp is `effectiveAccess`. The descriptor maps it through `mapEffectiveAccess` so Codex still gets a sandbox mode and Claude still gets a permission mode without those names leaking into `src/bot`. Each profile keeps its own adapter instance (or equivalent bound identity). Mutating a shared descriptor to inject identity is forbidden.

### 4.5 Profile

```yaml
agent:
  kind: kimi
  binaryPath: /home/bot/.local/bin/kimi     # optional; absent means detect via descriptor.binaryNames on PATH
  options: { ... }                          # validated by descriptor.agentOptionsSchema
```

One convention for binary location, for all kinds. The current three conventions (env var, `cursor/binary.ts` special resolver, PATH-only) collapse into this. Two bots of the same kind on one machine may point at two different binaries.

### 4.6 Persisted state

Every on-disk shape the bridge owns gets an explicit `schemaVersion`:
- profile `config.json` (already `schemaVersion: 2` today)
- session catalog at `${sessionsFile}.catalog.json`, deployed name `sessions.json.catalog.json`
- `sessions.json` (`SessionStore`, including idle-timeout overrides)
- `workspaces.json`
- process registry entries
- runtime lock metadata

Missing `schemaVersion` means 1 except for profiles, which already ship as 2.

---

## 5. Delivery shape (for pstack to turn into a plan)

The work is sequenced and coupled, so `autopilot-stack` is the right terminal playbook: one linear stack, the operator lands it. Suggested links, bottom up. pstack may split or merge as long as every link has one observable and every pin in section 3 stays green.

| link | content | depends on | main files |
|---|---|---|---|
| PR-0 | Pin harness. Tests P1 to P7. Old-shape fixtures committed. No production code change. | none | `tests/**`, `tests/helpers/fake-executable.ts` |
| PR-1 | Registry and descriptor (C1). Introduce `src/agent/registry.ts`; migrate every enumeration and `if` chain; remove `claude` fallthroughs; wizard reads registry; static contract test for zero stray unions. | PR-0 | `src/agent/*`, `src/runtime/agent-runtime.ts`, `src/runtime/profile-runtime.ts`, `src/runtime/registry.ts`, `src/runtime/locks.ts`, `src/commands/index.ts`, `src/cli/agent-detection.ts`, `src/config/profile-schema.ts`, `web/src/lib/types.ts`, `web/src/views/OnboardWizard.tsx` |
| PR-2 | JsonlCliRunner (C2). Runner module; all five adapters migrated; parameterized process suite replaces five copies. | PR-1 | `src/agent/runner/`, `src/agent/<kind>/adapter.ts`, `tests/process/` |
| PR-3 | Unified resume handle (C3) and reply mode on descriptor. Agent resume `sessionId`/`threadId` gone from shared agent code; catalog schema v2 with one-shot upgrade. Feishu `thread_id` and QR `sessionId` stay. | PR-1 | `src/agent/types.ts`, `src/bot/run-flow.ts`, `src/bot/comments.ts`, `src/bot/channel.ts`, `src/commands/index.ts`, `src/session/**` |
| PR-4 | Binary path in profile (C4). `agent.binaryPath` for all kinds; delete `cursor/binary.ts` special case and env-var path; detection uses `descriptor.binaryNames`; profile schema **v2 to v3** (profiles are already v2). | PR-1 | `src/config/profile-schema.ts`, `src/cli/agent-detection.ts`, `src/agent/cursor/binary.ts`, `src/runtime/profile-runtime.ts` |
| PR-5 | Private run options (C5). `agentOptions` bag; `descriptor.policyInputs` feeds the fingerprint; shared types stop naming codex/claude fields. Fingerprint golden test decides whether a version bump is needed. | PR-2, PR-3, PR-4 | `src/agent/types.ts`, `src/policy/fingerprint.ts`, `src/runtime/profile-runtime.ts` |
| PR-6 | Docs and README reframing (section 8). Delete dead code the static test now flags. | PR-5 | `README.md`, `README.zh.md`, `CONTEXT.md` |

PR-3 and PR-4 are independent of each other; an owner may build them in parallel, but the stack lands them in order.

---

## 6. Persisted-state upgrade policy

Decision from the operator: no technical debt, no permanent compatibility branches, no forced re-onboarding.

The pattern that satisfies both:

1. Every persisted shape carries `schemaVersion`. Missing means 1.
2. Each store has one loader. The loader reads the file, runs `upgrade(vN -> vN+1)` steps in sequence until current, then writes the current shape back and continues. Upgrade functions are pure and live next to the store in `migrations.ts`.
3. Code after the loader sees only the current shape. No `if (entry.threadId ?? entry.sessionId)` anywhere outside `migrations.ts`.
4. Each upgrade step has a fixture test: old file in, current shape out, and the upgraded file re-loads as a no-op.
5. Upgrade steps for a version are deleted two minor releases after they ship. The deletion is a normal PR; the CHANGELOG states the oldest version that can still be upgraded in place.

Concretely for this program:
- Catalog `sessions.json.catalog.json` v1 -> v2: `threadId` and `sessionId` both fold into `resumeHandle`. Codex entries keep resuming.
- Profile **v2 -> v3** (not v1 -> v2). Today's `ProfileConfig.schemaVersion` is already 2 (`src/config/profile-store.ts` accepts only 2). The new `agent: { kind, binaryPath, options }` block is v3. Loader runs the existing v1->v2 path, then v2->v3 in `src/config/migrations.ts`.
- `sessions.json` and `workspaces.json` gain `schemaVersion`. Idle-timeout overrides in `SessionStore` survive the upgrade.
- Lock metadata and process registry: add `schemaVersion`, no field changes expected. `isValidEntry` / `isRuntimeLockMeta` accept `isAgentKind()` instead of a literal list.
- Policy fingerprint: **V2 hashes stay byte-stable**. `descriptor.policyInputs` for Codex must reproduce `{ codexHome, inheritCodexHome }` in the same canonical form as `FingerprintInputV2`. Do not bump to V3. The catalog cannot re-fingerprint stored sessions because it stores only the digest.

---

## 7. Verification

Gates every link must pass: `pnpm ci:local` (diff check, tests, typecheck, build). The static contract test added in PR-1 is part of `pnpm test`.

Live floor (for the swarm at STACK-READY, not for CI):
- Start one supervisor with at least two heterogeneous profiles using fake CLIs. Mention each bot in its own Feishu chat (a Feishu test app exists in the operator's tenant; ask the operator for credentials, do not read them from the vault). Confirm isolation and resume across a restart.
- Run the three real smoke tests (`grok`, `kimi`, `cursor`) where the binary is present on the verifier machine; skip with reason where absent.
- Load a profile directory and a `sessions.json.catalog.json` copied from the operator's current deployment (redacted) and confirm the upgrade writes catalog v2 and resumes.

What the swarm should distrust: PR bodies claiming "no behavior change". Diff each link against the pin tests; a pin test that was edited in the same link is a finding.

---

## 8. Naming and docs

The repo is named for its deployment target, not its agent. Grok Bot is a SpaceXAI product: an always-on teammate that runs on a persistent Cursor-hosted cloud computer. This bridge is what that computer (or any VPS) runs to put CLI coding agents behind Feishu bots. Grok Build is one of the five agents and has no special standing.

README and README.zh must say this in the first paragraph and stop presenting Grok Build as the primary engine. `package.json` `description`, `repository`, `bugs`, and `homepage` still point at the upstream fork source and at "Grok Build (and other CLI coding agents)"; update them to this repo and to neutral wording.

---

## 9. Risks and open items

- **Fingerprint drift** is the one change that silently breaks resume for every user. PR-0's golden test exists so the team finds out in CI, not in Feishu. V3 re-hash of stored catalog rows is not a migration. It is data loss.
- **Review comments (Codex, Bugbot, security).** Triage per `pstack/skills/poteto-mode/references/bugbot-triage.md`. Spec-PR comments that change the contract land on PR #3 before the next implementation owner starts. Implementation-PR comments are that owner's job before STACK-READY. P1 correctness always fixes. P2 spec accuracy always fixes on the spec. Nitpicks dismiss with a concrete reason.
- **Models.** Every owner and swarm worker in this program is a Cursor Grok 4.6 model. No Claude, Kimi, or GPT dispatch.
- **Cursor CLI binary special case** (`src/agent/cursor/binary.ts`) exists because the CLI installs as `agent` in a versioned directory. `descriptor.binaryNames` plus `agent.binaryPath` must cover that install layout; the P7 fixture should include it.
- **Web console types.** `web/src/lib/types.ts` duplicates the union because the console builds separately. Pick one: a shared `src/agent/kinds.ts` consumed by both bundles, or a generated file. Do not leave two declarations.
- **`.planning/`** holds local planning-with-files state and is gitignored. Not part of this program.
- **pstack prerequisites.** `autopilot-stack` calls `/deslop` and its swarm lanes use `control-cli`, both from the `cursor-team-kit` plugin. Both plugins are public at `https://github.com/cursor/plugins`; a cloud root that lacks them locally clones that repo to `/tmp` and reads `pstack/skills/**` and `cursor-team-kit/skills/**` from there.
- **Forge.** Trunk is `master`. `gh` is installed and authenticated to `github.com` as `Rainnystone`; `origin` CLI is not installed. pstack uses `gh`.

---

## 10. How to hand this to pstack

In a fresh chat with `larkent-for-grokbot` open as the workspace root:

```text
/poteto-mode new task. multi-phase plan for docs/specs/multi-agent-runtime.md.
Read the spec in full. It is the design brief; write the phase plan from it, run the plan checker, then stop and show me the plan. Do not start building.
```

After you approve the plan:

```text
/poteto-mode autopilot-stack. build the plan, I'll land it.
```

Say "state the plan" if you want a restatement; that is not a go. Say "stop" to put every owner on a zero-writes hold.
