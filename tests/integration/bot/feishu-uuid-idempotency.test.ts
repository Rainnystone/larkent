import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { noticeDeliveryKey, replyDeliveryKey, TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { axiosErrno, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
const ANSWER = 'ONCE_ONLY';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('exactly-once Feishu uuid delivery', { timeout: 20_000 }, () => {
  it('resends a landed-but-lost response with the same uuid and keeps one chat message', async () => {
    const h = await harness();
    let drops = 1;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      const result = await orig(...args);
      if (drops > 0) {
        drops -= 1;
        throw sdkShapedSendError('unknown', axiosErrno('ECONNRESET', 'socket hang up'));
      }
      return result;
    };

    await h.channel.handlers.message?.(mention('om_src', 'please answer'));
    await waitFor(() => (
      h.journal.list().some((entry) => entry.status === 'completed-undelivered')
      && h.channel.sent.some((item) => JSON.stringify(item.content).includes(ANSWER))
    ));
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER))).toHaveLength(1);
    const landedId = h.channel.sent.find((item) => JSON.stringify(item.content).includes(ANSWER));
    const staged = h.journal.list().find((entry) => entry.messageIds.includes('om_src'));
    expect(staged?.reply?.deliveryId).toBe(replyDeliveryKey(staged!.turnId));
    expect((staged?.reply as { uuid?: string } | undefined)?.uuid).toBeUndefined();

    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'reply-delivered'));
    const answers = h.channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER));
    expect(answers).toHaveLength(1);
    const delivered = h.journal.list().find((entry) => entry.messageIds.includes('om_src'));
    expect(delivered?.reply?.messageId).toBeDefined();
    expect(delivered?.reply?.deliveryId).toBe(staged?.reply?.deliveryId);
    expect(JSON.stringify(answers[0]?.options)).toContain(staged!.reply!.deliveryId);
    expect(landedId).toBeDefined();
  });

  it('sends a notice twice with the same key and the chat holds one notice', async () => {
    const h = await harness({
      events: [
        { type: 'done', terminationReason: 'interrupted' },
      ],
    });
    await h.channel.handlers.message?.(mention('om_src', 'please answer'));
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('上一轮未完成')));
    const entry = h.journal.list().find((item) => item.messageIds.includes('om_src'));
    expect(entry?.notice?.deliveryId).toBe(noticeDeliveryKey(entry!.turnId));
    const before = h.channel.sent.filter((item) => JSON.stringify(item.content).includes('上一轮未完成')).length;

    await h.bridge.recoverMissed();
    const notices = h.channel.sent.filter((item) => JSON.stringify(item.content).includes('上一轮未完成'));
    expect(notices).toHaveLength(before);
    expect(before).toBe(1);
    expect(JSON.stringify(notices[0]?.options)).toContain(noticeDeliveryKey(entry!.turnId));
  });
});

async function harness(opts: { events?: FakeAgentEvents } = {}) {
  const tmp = await createTmpProfile('feishu-uuid-');
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_bot', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = tmp.workspace;
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: opts.events ?? [
      { type: 'text', delta: ANSWER },
      { type: 'final_text', content: ANSWER },
      { type: 'done', terminationReason: 'normal' },
    ],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    journal,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'ok',
      botOwnerId: USER,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-uuid',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, journal };
}

function mention(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected uuid delivery transition was not observed');
}
