import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { ActiveRuns } from '../../src/bot/active-runs';
import { ChatModeCache, type ChatMode } from '../../src/bot/chat-mode-cache';
import { PendingQueue } from '../../src/bot/pending-queue';
import { TurnJournal } from '../../src/bot/turn-journal';
import { NoticeActionAuth } from '../../src/bot/interruption-notice';
import { CallbackAuth } from '../../src/card/callback-auth';
import { CallbackNonceStore } from '../../src/card/callback-store';
import { AutoActionAuth } from '../../src/automations/action-auth';
import { BoardActionAuth } from '../../src/automations/board-auth';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { ResumeCandidates } from '../../src/session/resume-candidates';
import { SessionStore } from '../../src/session/store';
import { WorkspaceStore } from '../../src/workspace/store';
import type { Controls, UserActionContext, UserActionRuntime } from '../../src/user-actions/context';
import { cardActionMessage } from '../../src/user-actions/message';
import { FakeAgentAdapter } from './fake-agent';
import { createFakeChannel } from './fake-channel';
import { createTmpProfile } from './tmp-profile';

export function userActionEvent(value: Record<string, unknown>, formValue?: Record<string, unknown>, operatorId = 'ou_operator'): CardActionEvent {
  return {
    action: { tag: 'button', value }, chatId: 'oc_group', messageId: 'om_card',
    operator: { openId: operatorId, name: 'Operator' },
    ...(formValue ? { raw: { action: { form_value: formValue } } } : {}),
  };
}

/** Real stores/queues/auth, with a recording channel at the Feishu seam. */
export async function createUserActionHarness(mode: ChatMode = 'group') {
  const tmp = await createTmpProfile('user-action-');
  const channel = createFakeChannel();
  const larkChannel = Object.assign(channel, { getChatMode: async () => mode }) as unknown as LarkChannel;
  const agent = new FakeAgentAdapter();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const nonces = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
  const journal = new TurnJournal(`${tmp.profile}/turn-journal.json`);
  await journal.load();
  const pending = new PendingQueue(60_000, () => {});
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'] },
  });
  const controls: Controls = {
    profile: 'claude', profileConfig, cfg: profileConfig, botOwnerId: 'ou_owner', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
    configPath: `${tmp.profile}/config.json`, processId: 'proc-1',
  };
  let nonceSeq = 0;
  const authOptions = { secret: 'test-secret', nonceStore: nonces, now: () => 1000, createNonce: () => `nonce-${nonceSeq++}` };
  const auth = new CallbackAuth({ ...authOptions, keys: [{ version: 1, secret: 'test-secret' }] });
  const runtime: UserActionRuntime = {
    channel: larkChannel, agent, sessions, workspaces, controls, journal, pending,
    activeRuns: new ActiveRuns(), resumeCandidates: new ResumeCandidates(), chatModeCache: new ChatModeCache(),
    callbackAuth: auth, callbackPolicyFingerprint: 'fp-1', noticeAuth: new NoticeActionAuth(authOptions),
    autoAuth: new AutoActionAuth(authOptions), boardAuth: new BoardActionAuth(authOptions), now: () => 1000,
  };
  const context: UserActionContext = {
    ...runtime, msg: cardActionMessage(userActionEvent({}), mode), scope: 'oc_group', chatMode: mode, origin: 'card',
  };
  return {
    tmp, channel, agent, sessions, workspaces, pending, controls, journal, auth, runtime, context,
    activeRuns: runtime.activeRuns,
    async cleanup() {
      pending.cancelAll();
      await Promise.all([sessions.flush(), workspaces.flush(), nonces.flush(), journal.flush()]);
      await tmp.cleanup();
    },
  };
}
