import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth.js';
import { AutomationsStore } from '../../../src/automations/store.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { ResumeCandidates } from '../../../src/session/resume-candidates.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const CHAT = 'oc_group';
const USER = 'ou_user';
const CARD_MESSAGE = 'om_card';
const NOW = Date.UTC(2026, 9, 20, 10, 18, 0);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('confirm card action latency', () => {
  it('returns the success toast without waiting for a slow onAutomationConfirmed, and still settles', async () => {
    const h = await createHarness();
    const draft = await h.store.saveDraft({
      taskType: 'reminder',
      schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
      timezone: 'Asia/Shanghai',
      startAt: NOW,
      endAt: NOW + 60 * 60_000,
      nextFireAt: NOW + 60 * 60_000,
      chatId: CHAT,
      createdBy: USER,
      name: '交周报',
      taskText: '提醒交周报',
    });
    await h.store.bindDraftCard(draft.draftId, CARD_MESSAGE);

    let releaseConfirm!: () => void;
    const hung = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    cleanups.push(async () => {
      releaseConfirm();
      await hung;
    });
    const onAutomationConfirmed = async () => {
      await hung;
    };

    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const token = h.autoAuth.sign({
      draftId: draft.draftId,
      chatId: CHAT,
      action: 'auto.confirm',
      ttlMs: 60_000,
    });

    const action = handleCardAction({
      channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'auto.confirm', auto_token: token }),
      sessions: h.sessions,
      resumeCandidates: h.resumeCandidates,
      workspaces: h.workspaces,
      activeRuns: h.activeRuns,
      agent: h.agent,
      controls: h.controls,
      pending: h.pending,
      chatModeCache: h.chatModeCache,
      autoAuth: h.autoAuth,
      automations: h.store,
      now: () => NOW,
      onAutomationConfirmed,
    });
    const raced = await Promise.race([
      action.then((response) => ({ kind: 'done' as const, response })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 150);
      }),
    ]);
    expect(raced).toEqual({
      kind: 'done',
      response: { toast: { type: 'success', content: '已确认 #1' } },
    });
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0]).toMatchObject({ id: 1, name: '交周报' });

    expect(info).toHaveBeenCalledWith('cardAction', 'received', { cmd: 'auto.confirm' });
    expect(info).toHaveBeenCalledWith(
      'cardAction',
      'responded',
      expect.objectContaining({ cmd: 'auto.confirm', ms: expect.any(Number) }),
    );
    const responded = info.mock.calls.find((call) => call[0] === 'cardAction' && call[1] === 'responded');
    expect((responded?.[2] as { ms: number }).ms).toBeLessThan(200);

    await vi.waitFor(() => {
      expect(JSON.stringify(h.channel.updatedCards.at(-1)?.card)).toContain('已确认 #1');
    });
    expect(info).toHaveBeenCalledWith(
      'auto',
      'draft-card-settled',
      expect.objectContaining({ draftId: draft.draftId, status: '已确认 #1' }),
    );
    expect(h.store.listDrafts()).toHaveLength(0);
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
  autoAuth: AutoActionAuth;
  store: AutomationsStore;
}> {
  const tmp = await createTmpProfile('confirm-action-latency-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const resumeCandidates = new ResumeCandidates();
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const nonceStore = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: [CHAT], allowedUsers: [USER] },
  });
  profileConfig.automations.enabled = true;
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: USER,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const autoAuth = new AutoActionAuth({
    secret: 'auto-secret',
    nonceStore,
    now: () => NOW,
  });
  const store = new AutomationsStore({
    path: `${tmp.profile}/automations.json`,
    logPath: `${tmp.profile}/automations.log`,
    statusPath: `${tmp.profile}/automations-status.json`,
    now: () => NOW,
  });
  await store.load();
  const chatModeCache = {
    resolve: async () => 'group' as const,
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), nonceStore.flush()]);
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
    autoAuth,
    store,
  };
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: CHAT,
    messageId: CARD_MESSAGE,
    operator: {
      openId: USER,
      name: 'Operator',
    },
  } as unknown as CardActionEvent;
}
