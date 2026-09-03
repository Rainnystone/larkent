import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityForProfile } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import {
  SessionCatalog,
  sessionCatalogKey,
  type SessionCatalogEntry,
} from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { PINNED_AGENT_KINDS, type PinnedAgentKind } from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('P2 v1 catalog resume', () => {
  it.each(PINNED_AGENT_KINDS)('loads the committed v1 catalog for %s and resumes the stored handle', async (kind) => {
    const loaded = new SessionCatalog(
      join(process.cwd(), 'tests/fixtures/sessions', `catalog-v1-${kind}.json`),
    );
    await loaded.load();
    expect(loaded.entries()).toHaveLength(1);
    const [entry] = loaded.entries();
    expect(entry?.agentId).toBe(kind);
    if (kind === 'codex') {
      expect(entry?.threadId).toBe('thread-v1-codex');
      expect(entry?.sessionId).toBeUndefined();
    } else {
      expect(entry?.sessionId).toBe(`sess-v1-${kind}`);
      expect(entry?.threadId).toBeUndefined();
    }

    const h = await createHarness(kind);
    const cwdRealpath = await realpath(h.tmp.workspace);
    const probe = await start(h);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('expected probe run');
    await drain(probe.execution.subscribe());

    const bound = bindFixture(entry!, {
      scopeId: 'chat-1',
      agentId: kind,
      cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
    });
    await h.catalog.replaceForTest([bound]);

    const resumed = await start(h);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    const resumedOpts = h.agent.runOptions[1];
    if (kind === 'codex') {
      expect(resumed.resumeFrom).toBe('thread-v1-codex');
      expect(resumedOpts?.threadId).toBe('thread-v1-codex');
      expect(resumedOpts?.sessionId).toBeUndefined();
    } else {
      expect(resumed.resumeFrom).toBe(`sess-v1-${kind}`);
      expect(resumedOpts?.sessionId).toBe(`sess-v1-${kind}`);
      expect(resumedOpts?.threadId).toBeUndefined();
    }
  });
});

function bindFixture(
  entry: SessionCatalogEntry,
  identity: {
    scopeId: string;
    agentId: PinnedAgentKind;
    cwdRealpath: string;
    policyFingerprint: string;
  },
): SessionCatalogEntry {
  const next: SessionCatalogEntry = {
    ...entry,
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    key: sessionCatalogKey(identity),
  };
  return next;
}

async function createHarness(agentKind: PinnedAgentKind): Promise<{
  tmp: Awaited<ReturnType<typeof createTmpProfile>>;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile(`catalog-v1-${agentKind}-`);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [
      [{ type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.catalog.json'));
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
      workspaces: { ...profileConfig.workspaces, default: tmp.workspace },
    },
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function start(h: Awaited<ReturnType<typeof createHarness>>) {
  return startRunFlow({
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
  });
}
