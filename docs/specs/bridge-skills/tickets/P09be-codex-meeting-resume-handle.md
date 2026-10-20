# Task 09be — Codex meeting follow-up loses its thread handle

**Status:** awaiting review — audit finding; implementation is not approved.
**Priority:** proposed P2.
**Responsibility:** bridge bug in the shared meeting consumer; reproduced with the Codex adapter. No upstream authentication/provider defect is alleged.
**Blocked by:** review/implementation authorization. No functional dependency on P09bc/P09bd; coordinate meeting-file ownership with P09bf if either is approved.
**Audit:** [evidence index](../codex-compatibility-audit.md), 2026-10-20.
**Fixed code:** PR52 `feat/bridge-skills` at `8949a2d1c4339a777b1c4ff04af8443d5272e75b`.
**Versions:** larkent package 0.7.0; Node 24.19.0; installed Codex CLI 0.159.2 (help/version only); controlled executable 0.0.0-pin. Official Codex `rust-v0.159.2` source: `ff6aec96948b70d94983af2641a6b67c94faeff5`.
**Pre-publication check:** read the later P09bc code/test change at `2e64fa0a634b8934d2d3dc98a41940149692dd53`. The meeting/adapter paths are unchanged; the portable probe was rerun on a separate export of that head and still reproduces. The frozen audit baseline remains the SHA above.

## Problem and user stories

A participant asks Codex to remember a synthetic decision, then asks a follow-up in the same meeting. The bridge launches another fresh Codex turn without the first thread's resume handle. A follow-up that relies on the prior answer or tool work can lose that context. Recent meeting transcript context is separate from the missing Codex conversation.

1. As a meeting participant, I want my follow-up to continue this meeting's Codex conversation.
2. As a participant in another meeting, I want its conversation to remain separate.

## Observed evidence and inference

The reproduction uses real `answerInMeeting → startRunFlow → RunExecutor → CodexAdapter → runJsonlCli` and a controlled subprocess emitting canonical Codex JSONL. Only external Codex execution and Feishu delivery are controlled; no model or live service is called.

Observed twice: the adapter emits `system.resumeHandle`, the first answer reaches both recording destinations, the catalog has zero entries, both submissions use the same policy fingerprint, and the second adapter input has no `resumeHandle`. The process pool returns to zero active processes. Seeding the catalog with the first handle and the observed identity makes the second input carry it. This control changes fixture state only, not product code.

Minimal synthetic result: `systemHandleObserved=true; entriesAfterFirst=0; samePolicy=true; secondHasResumeHandle=false`. With the catalog control, only the final field becomes `true`.

Source: the [meeting drain](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/meeting/orchestrator.ts#L394-L423) collects text but never records system handles. The existing [recording seam](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/bot/run-flow.ts#L240-L258) owns that catalog update, and [resume lookup](https://github.com/Rainnystone/larkent/blob/8949a2d1c4339a777b1c4ff04af8443d5272e75b/src/bot/run-flow.ts#L109-L123) uses the catalog for Codex. The production channel supplies the catalog to meeting consumers. Official [thread event schema](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L10-L52) defines the handle-bearing event.

Inferred user consequence: native conversational memory will be unavailable through resume when the handle is omitted. Actual native memory loss was not tested.

## Minimal proposed boundary and non-goals

Use the existing session-recording contract for meeting system events, under the resolved meeting scope, agent, cwd and policy fingerprint. Preserve existing lookup/isolation rules. No new session database or routing abstraction is needed.

No product change is included in this audit. Non-goals: Codex login/API adapters, provider behavior, new environment filtering, other CLI audits, meeting transcript redesign, process-tree or JSONL-size fixes.

## Acceptance criteria and test seam

- [ ] At the same controlled-process seam, two successful questions in one meeting pass the first Codex handle into the second run.
- [ ] A different meeting and an incompatible cwd/policy identity do not reuse that handle.
- [ ] Normal answers still reach the configured destination once; process/pool cleanup remains complete.
- [ ] Test the meeting caller and adapter boundary, rather than only the catalog helper. Native resume memory remains a separately labeled acceptance gap.

Overlap: P09ay/P09az/P09bb are already represented by the frozen code; P09bc/P09bd cover process cleanup and JSONL limits. None covers this missing recording call. P09bf shares the consumer but concerns terminal failure delivery and can be reviewed independently.

## Sanitized reproduction

Use the script below from a clean export of the fixed snapshot with its dependencies. Save it as a temporary `.mts` file outside the checkout. Run with the existing `tsx` executable from the snapshot root:

```sh
node_modules/.bin/tsx /tmp/codex-meeting-audit.mts resume
AUDIT_SEED_CATALOG=1 node_modules/.bin/tsx /tmp/codex-meeting-audit.mts resume
node_modules/.bin/tsx /tmp/codex-meeting-audit.mts failure
```

The first command exits 1 on the missing-handle assertion; the catalog control exits 0. The final command is P09bf's independent failure-delivery probe and exits 1 on this snapshot. All fixture content is synthetic, and all temporary profile files are removed after each completed probe.

```typescript
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href);
const { CodexAdapter } = await load('src/agent/codex/adapter.ts');
const { ActiveRuns } = await load('src/bot/active-runs.ts');
const { ProcessPool } = await load('src/bot/process-pool.ts');
const { createDefaultProfileConfig } = await load('src/config/profile-schema.ts');
const { answerInMeeting } = await load('src/meeting/orchestrator.ts');
const { MeetingSession } = await load('src/meeting/session.ts');
const { RunExecutor } = await load('src/runtime/run-executor.ts');
const { SessionCatalog } = await load('src/session/catalog.ts');
const { SessionStore } = await load('src/session/store.ts');
const { WorkspaceStore } = await load('src/workspace/store.ts');
const { writeScriptedJsonlExecutable } = await load('tests/helpers/fake-executable.ts');
const { createRecordingLarkChannel } = await load('tests/helpers/recording-lark-channel.ts');
const { createTmpProfile } = await load('tests/helpers/tmp-profile.ts');

const mode = process.argv[2];
assert.ok(mode === 'resume' || mode === 'failure');
const tmp = await createTmpProfile('synthetic-codex-meeting-');
const lines = mode === 'failure'
  ? [{ type: 'thread.started', thread_id: 'synthetic-thread-a' }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: 'Synthetic upstream failure' } }]
  : [{ type: 'thread.started', thread_id: 'synthetic-thread-a' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'synthetic-answer', type: 'agent_message', text: 'Synthetic answer' } }, { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }];
const binary = await writeScriptedJsonlExecutable(tmp.root, 'synthetic-cli.mjs', { lines, exitCode: mode === 'failure' ? 1 : 0 });
const cfg = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: binary.path }, accounts: { app: { id: 'synthetic-app', secret: 'synthetic-placeholder', tenant: 'feishu' } } });
cfg.workspaces.default = tmp.workspace;
cfg.meeting.enabled = true;
cfg.meeting.respondIn = 'both';
const adapter = new CodexAdapter({ binary: binary.path, profileStateDir: tmp.profile, sandbox: 'read-only' });
const inputs: any[] = [];
const observed: any[] = [];
const realRun = adapter.run.bind(adapter);
adapter.run = opts => {
  inputs.push(opts);
  const run = realRun(opts);
  const source = run.events;
  run.events = { async *[Symbol.asyncIterator]() { for await (const event of source) { observed.push(event); yield event; } } };
  return run;
};
const activeRuns = new ActiveRuns();
const pool = new ProcessPool(() => 1);
const executor = new RunExecutor({ agent: adapter, activeRuns, pool });
const submissions: any[] = [];
const realSubmit = executor.submit.bind(executor);
executor.submit = input => { submissions.push(input); return realSubmit(input); };
const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
const sessionCatalog = new SessionCatalog(join(tmp.profile, 'catalog.json')); await sessionCatalog.load();
const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
let meetingSends = 0;
const session = new MeetingSession({ client: { request: async () => { meetingSends++; return { code: 0, data: {} } as never; } }, meetingId: 'synthetic-meeting', meetingNo: '123456789', originChatId: 'synthetic-chat', config: cfg.meeting, joinedWithAccessCheck: true });
const channel = createRecordingLarkChannel();
const controls: any = { profile: 'synthetic', profileConfig: cfg, cfg, ownerRefreshState: 'unknown', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-process' };
const deps: any = { session, channel, controls, executor, activeRuns, sessions, sessionCatalog, workspaces };
try {
  const first = await answerInMeeting(deps, 'Synthetic question one', { deliver: 'broadcast', admitted: true });
  if (mode === 'resume') {
    assert.equal(first, 'Synthetic answer');
    const entriesAfterFirst = sessionCatalog.entries().length;
    if (process.env.AUDIT_SEED_CATALOG === '1') sessionCatalog.upsertActive({ scopeId: 'meeting:synthetic-meeting', agentId: 'codex', cwdRealpath: inputs[0].cwd, policyFingerprint: submissions[0].policy.policyFingerprint, resumeHandle: 'synthetic-thread-a' });
    await answerInMeeting(deps, 'Synthetic follow-up question', { deliver: 'caller', admitted: true });
    console.log(JSON.stringify({ case: mode, systemHandleObserved: observed.some(e => e.type === 'system' && e.resumeHandle === 'synthetic-thread-a'), entriesAfterFirst, samePolicy: submissions[0].policy.policyFingerprint === submissions[1].policy.policyFingerprint, firstReply: true, meetingSends, imSends: channel.sent.length, secondHasResumeHandle: Boolean(inputs[1].resumeHandle), activeProcesses: pool.snapshot().active }));
    assert.equal(inputs[1].resumeHandle, 'synthetic-thread-a', 'Meeting follow-up must pass first Codex thread handle');
  } else {
    console.log(JSON.stringify({ case: mode, answerLength: first.length, meetingSends, imSends: channel.sent.length, activeProcesses: pool.snapshot().active }));
    assert.ok(first.length > 0 && meetingSends > 0 && channel.sent.length > 0, 'A failed meeting run must deliver a failure notice');
  }
} finally {
  await activeRuns.stopAll({ type: 'meeting' });
  await Promise.all([sessions.flush(), workspaces.flush()]);
  await sessionCatalog.flush();
  await tmp.cleanup();
}
```
