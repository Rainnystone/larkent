import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { descriptorFor, type AgentKind } from '../../../src/agent/registry.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('attachment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(['claude', 'codex', 'kimi', 'grok', 'cursor'] as const)('passes accepted image paths only when %s accepts images', async (kind) => {
    const h = await createHarness(kind);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
      capability: descriptorFor(kind).capability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: kind === 'codex' ? ['/media/image.png'] : undefined,
    });
  });
});

async function createHarness(kind: AgentKind): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('attachment-run-flow-');
  const agent = new FakeAgentAdapter({
    id: kind,
    displayName: 'Codex',
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
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
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}
