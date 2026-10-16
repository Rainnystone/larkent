import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { NoticeActionAuth } from '../../../src/bot/interruption-notice.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { TurnJournal } from '../../../src/bot/turn-journal.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { ResumeCandidates } from '../../../src/session/resume-candidates.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('notice card dispatch', () => {
  it('lets an allowed non-initiator continue and rejects a fenced-out owner', async () => {
    const h = await harness({ fence: true });
    const seen: string[] = [];
    h.onNotice = (operatorId) => {
      seen.push(operatorId);
    };

    await h.dispatch('ou_mate', h.token());
    expect(seen).toEqual(['ou_mate']);

    await h.dispatch('ou_owner', h.token({ nonce: 'nonce-owner' }));
    expect(seen).toEqual(['ou_mate']);
    expect(h.actions).toEqual(['ou_mate']);
  });

  it('rejects a replayed nonce', async () => {
    const h = await harness();
    const token = h.token();
    await h.dispatch('ou_user', token);
    await h.dispatch('ou_user', token);
    expect(h.actions).toEqual(['ou_user']);
  });

  it('rejects a continue whose policy fingerprint no longer matches', async () => {
    const h = await harness();
    h.journal.noteTurnMeta('turn-1', { policyFingerprint: 'fp-other' });
    await h.dispatch('ou_user', h.token());
    expect(h.actions).toEqual([]);
    expect(JSON.stringify(h.channel.sent)).toMatch(/失效/);
  });
});

async function harness(opts: { fence?: boolean } = {}) {
  const tmp: TmpProfile = await createTmpProfile('notice-dispatch-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const resumeCandidates = new ResumeCandidates();
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const journal = new TurnJournal(`${tmp.profile}/turn-journal.json`);
  await journal.load();
  journal.enqueue({
    turnId: 'turn-1',
    scope: 'oc_group',
    chatId: 'oc_group',
    messageIds: ['om_1'],
    senderId: 'ou_user',
    initiatorId: 'ou_user',
    status: 'notice-delivered',
    policyFingerprint: 'fp-1',
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      ...(opts.fence ? { fence: { enabled: true } } : {}),
      allowedChats: ['oc_group'],
      allowedUsers: ['ou_user', 'ou_mate'],
    },
  });
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const callbackAuth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
  });
  let nonceSeq = 0;
  const noticeAuth = new NoticeActionAuth({
    secret: 'notice-secret',
    nonceStore: store,
    now: () => 1000,
    createNonce: () => `nonce-${nonceSeq++}`,
  });
  const actions: string[] = [];
  const chatModeCache = { resolve: async () => 'group' as const } as unknown as ChatModeCache;
  const state = {
    actions,
    journal,
    channel,
    onNotice: (_operatorId: string) => {},
    token(overrides: { nonce?: string } = {}) {
      if (overrides.nonce) {
        return new NoticeActionAuth({
          secret: 'notice-secret',
          nonceStore: store,
          now: () => 1000,
          createNonce: () => overrides.nonce!,
        }).sign({
          turnId: 'turn-1',
          scope: 'oc_group',
          chatId: 'oc_group',
          action: 'notice.continue',
          policyFingerprint: 'fp-1',
          ttlMs: 60_000,
        });
      }
      return noticeAuth.sign({
        turnId: 'turn-1',
        scope: 'oc_group',
        chatId: 'oc_group',
        action: 'notice.continue',
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    async dispatch(operatorId: string, token: string) {
      await handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: {
          action: { value: { cmd: 'notice.continue', notice_token: token } },
          chatId: 'oc_group',
          messageId: 'om_card',
          operator: { openId: operatorId, name: 'Op' },
        } as unknown as CardActionEvent,
        sessions,
        resumeCandidates,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        callbackAuth,
        journal,
        noticeAuth,
        onNoticeAction: async ({ operatorId: id }) => {
          actions.push(id);
          state.onNotice(id);
        },
      });
    },
  };
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush(), journal.flush()]);
    await tmp.cleanup();
  });
  return state;
}
