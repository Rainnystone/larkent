import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityForProfile } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow, type StartRunFlowInput } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog, sessionCatalogKey } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import {
  PIN_AGENT_KINDS,
  adapterDisplayName,
  pinAgentKind,
  type PinAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];
const fixtureRoot = join(process.cwd(), 'tests/fixtures/sessions');

describe('P2 catalog v1 resume continuity', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(PIN_AGENT_KINDS)('loads the v1 catalog fixture and resumes through SessionCatalog + startRunFlow for %s', async (kind) => {
    const pinned = pinAgentKind(kind);
    const h = await createHarness(pinned);
    const cwdRealpath = await realpath(h.tmp.workspace);
    const probe = await start(h);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('expected probe run to compute policy');
    await drain(probe.execution.subscribe());

    const fixturePath = join(fixtureRoot, `catalog-v1-${pinned}.json`);
    const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as Array<{
      agentId: string;
      status: string;
      sessionId?: string;
      threadId?: string;
      scopeId: string;
      cwdRealpath: string;
      policyFingerprint: string;
      key: string;
      updatedAt: number;
    }>;
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);
    const template = raw[0]!;
    expect(template.agentId).toBe(pinned);
    expect(template.status).toBe('active');
    if (pinned === 'codex') {
      expect(template.threadId).toBe('thread-v1-codex');
      expect(template.sessionId).toBeUndefined();
    } else {
      expect(template.sessionId).toBe(`sess-v1-${pinned}`);
      expect(template.threadId).toBeUndefined();
    }

    const materialized = raw.map((entry) => ({
      ...entry,
      cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
      key: sessionCatalogKey({
        scopeId: entry.scopeId,
        agentId: pinned,
        cwdRealpath,
        policyFingerprint: probe.policy.policyFingerprint,
      }),
    }));
    await writeFile(join(h.tmp.profile, 'sessions.json.catalog.json'), `${JSON.stringify(materialized, null, 2)}\n`);
    await h.catalog.load();

    const loaded = h.catalog.activeFor({
      scopeId: 'chat-1',
      agentId: pinned,
      cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
    });
    expect(loaded).toBeDefined();
    expect(loaded?.resumeHandle).toBe(pinned === 'codex' ? 'thread-v1-codex' : `sess-v1-${pinned}`);
    expect(loaded).not.toHaveProperty('sessionId');
    expect(loaded).not.toHaveProperty('threadId');

    const resumed = await start(h);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resume');
    const handle = pinned === 'codex' ? 'thread-v1-codex' : `sess-v1-${pinned}`;
    expect(resumed.resumeFrom).toBe(handle);
    const resumeOpts = h.agent.runOptions[1];
    expect(resumeOpts).toBeDefined();
    expect(resumeOpts?.resumeHandle).toBe(handle);
    expect(resumeOpts).not.toHaveProperty('sessionId');
    expect(resumeOpts).not.toHaveProperty('threadId');
  }, 20_000);

  it('keeps committed v1 catalog files loadable without rewriting the fixture bytes', async () => {
    for (const kind of PIN_AGENT_KINDS) {
      const pinned = pinAgentKind(kind);
      const tmp = await createTmpProfile(`catalog-load-${pinned}-`);
      cleanups.push(tmp.cleanup);
      const dest = join(tmp.profile, 'sessions.json.catalog.json');
      await copyFile(join(fixtureRoot, `catalog-v1-${pinned}.json`), dest);
      const catalog = new SessionCatalog(dest);
      await catalog.load();
      const entries = catalog.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.agentId).toBe(pinned);
      expect(entries[0]?.cwdRealpath).toBe('/PINNED_CWD');
      expect(entries[0]?.policyFingerprint).toBe('PINNED_FP');
      expect(entries[0]?.resumeHandle).toBe(
        pinned === 'codex' ? 'thread-v1-codex' : `sess-v1-${pinned}`,
      );
      expect(entries[0]).not.toHaveProperty('sessionId');
      expect(entries[0]).not.toHaveProperty('threadId');
    }
  });
});

async function createHarness(kind: PinAgentKind): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile(`catalog-v1-${kind}-`);
  const agent = new FakeAgentAdapter({
    id: kind,
    displayName: adapterDisplayName(kind),
    events: [
      [{ type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(kind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex', inheritCodexHome: false } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.json.catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    void _event;
  }
}

async function start(h: Awaited<ReturnType<typeof createHarness>>) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability: capabilityForProfile(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  } satisfies StartRunFlowInput & { sessionCatalog: SessionCatalog };
  return startRunFlow(input);
}
