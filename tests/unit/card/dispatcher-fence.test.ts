import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { ResumeCandidates } from '../../../src/session/resume-candidates.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('card dispatcher access fence', () => {
  it('rejects a clicker who is not on the fence allowlists', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    await handleCardAction({
      channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({
        cmd: 'stop',
        __bridge_cb: true,
        bridge_token: h.token('stop'),
      }),
      sessions: h.sessions,
      resumeCandidates: h.resumeCandidates,
      workspaces: h.workspaces,
      activeRuns: h.activeRuns,
      agent: h.agent,
      controls: h.controls,
      pending: h.pending,
      chatModeCache: h.chatModeCache,
      callbackAuth: h.auth,
      callbackPolicyFingerprint: 'fp-1',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      'cardAction',
      'skip-not-allowed-user',
      expect.objectContaining({ reason: 'denied-user' }),
    );
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: ReturnType<typeof createFakeChannel>;
  sessions: SessionStore;
  resumeCandidates: ResumeCandidates;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  auth: CallbackAuth;
  token(action: string): string;
}> {
  const tmp = await createTmpProfile('dispatcher-fence-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const resumeCandidates = new ResumeCandidates();
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      fence: { enabled: true },
      allowedChats: ['oc_group'],
      allowedUsers: ['ou_allowed'],
    },
  });
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => 'nonce-stop',
  });
  const chatModeCache = {
    resolve: async () => 'group' as const,
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    sessions,
    resumeCandidates,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    chatModeCache,
    auth,
    token: (action) =>
      auth.sign({
        runId: 'run-active',
        scope: 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      }),
  };
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
  } as unknown as CardActionEvent;
}
