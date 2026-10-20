# Codex meeting controlled-process reproduction

Historical evidence artifact for [P09be](../tickets/P09be-codex-meeting-resume-handle.md) and [P09bf](../tickets/P09bf-codex-meeting-failure-notice.md). Moved unchanged from the original P09be runnable reproduction during docs readiness correction. This file is evidence, not an implementation ticket or a new product/test-source change.

**Evidence pins:** code `8949a2d1c4339a777b1c4ff04af8443d5272e75b`; probes also reproduced on `2e64fa0a634b8934d2d3dc98a41940149692dd53`. Native Codex models and live Feishu delivery were not used. Canonical JSONL and all fixture data are synthetic.

**Interpretation limit:** the historical `resume` probe sends broadcast first and caller-mode second. Its missing catalog entry and unchanged fingerprint demonstrate current recording/routing behavior; the catalog-seeding control is diagnostic. Pinned upstream code uses a shared conversation per meeting; caller selects an output route and does not guarantee private single-user memory. Restoring persistence can allow caller→broadcast reuse under that same scope, a static-derived consequence rather than demonstrated native memory or disclosure. The owner preserved that reference scope but subsequently held both repairs because they affect shared behavior. The [specification](../codex-meeting-followups.md) records the source and current scope restriction.

## Run the historical probe


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
