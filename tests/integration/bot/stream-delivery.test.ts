import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import {
  axiosErrno,
  axiosHttpError,
  sdkShapedSendError,
} from '../../helpers/sdk-feishu-errors';
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
const ANSWER = 'STREAM_FINAL';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('stream result is the delivery signal', { timeout: 20_000 }, () => {
  it('reports a markdown ENETUNREACH final write and recovers the same message', async () => {
    const h = await harness({ replyMode: 'markdown' });
    h.channel.streamErrors.finish = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );

    await h.channel.handlers.message?.(mention('om_md', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_md') && entry.status === 'completed-undelivered'
    )));
    const streamId = h.channel.streams[0]?.messageId;
    expect(streamId).toBeTruthy();
    expect(answerSends(h.channel)).toHaveLength(0);

    await recoverLink(h);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_md') && entry.status === 'reply-delivered'
    )));
    expect(answerSends(h.channel)).toHaveLength(0);
    expect(h.channel.updatedCards.some((row) => (
      row.messageId === streamId && JSON.stringify(row.card).includes(ANSWER)
    ))).toBe(true);
  });

  it('does not offer 继续 for a completed card whose final patch failed', async () => {
    const h = await harness({ replyMode: 'card' });
    h.channel.streamErrors.finish = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );

    await h.channel.handlers.message?.(mention('om_short', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_short') && entry.status === 'completed-undelivered'
    )));
    expect(noticeSends(h.channel)).toHaveLength(0);

    await recoverLink(h);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_short') && entry.status === 'reply-delivered'
    )));
    expect(noticeSends(h.channel)).toHaveLength(0);
    const streamId = h.channel.streams[0]?.messageId;
    expect(h.channel.updatedCards.some((row) => (
      row.messageId === streamId && JSON.stringify(row.card).includes(ANSWER)
    ))).toBe(true);
    expect(answerSends(h.channel)).toHaveLength(0);
  });

  it('drops a permanently rejected live-sweep patch after one attempt without a uuid-send', async () => {
    const h = await harness({ replyMode: 'card' });
    h.channel.streamErrors.finish = sdkShapedSendError('unknown', axiosHttpError(400));
    const origUpdate = h.channel.updateCard.bind(h.channel);
    let patches = 0;
    h.channel.updateCard = async (messageId, card) => {
      patches += 1;
      if (patches === 1) {
        throw sdkShapedSendError('unknown', axiosHttpError(400));
      }
      return origUpdate(messageId, card);
    };

    await h.channel.handlers.message?.(mention('om_400', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_400') && entry.reply?.state === 'rejected'
    )));
    const patchesWhenDropped = patches;
    expect(patchesWhenDropped).toBe(1);
    expect(answerSends(h.channel)).toHaveLength(0);
    expect(h.channel.streams.length).toBe(1);

    await h.bridge.recoverMissed();
    await h.bridge.recoverMissed();
    expect(patches).toBe(patchesWhenDropped);
    expect(answerSends(h.channel)).toHaveLength(0);
    expect(h.channel.streams.length).toBe(1);
  });

  it('uuid-sends the full answer after recovery when stream open creates no message', async () => {
    const h = await harness({ replyMode: 'card' });
    h.channel.streamErrors.open = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );

    await h.channel.handlers.message?.(mention('om_open', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_open') && entry.status === 'completed-undelivered'
    )));
    expect(h.channel.streams[0]?.messageId ?? '').toBe('');
    expect(answerSends(h.channel)).toHaveLength(0);

    await recoverLink(h);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_open') && entry.status === 'reply-delivered'
    )));
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(JSON.stringify(answerSends(h.channel)[0]?.content)).toContain(ANSWER);
  });

  it('stages a hung stream close and recovers exactly one complete markdown answer', async () => {
    const h = await harness({ replyMode: 'markdown', outboundTimeoutMs: 40 });
    h.channel.streamErrors.hangFinish = true;

    await h.channel.handlers.message?.(mention('om_hang', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_hang') && entry.status === 'completed-undelivered'
    )));
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_hang') && entry.status === 'running'
    ))).toBe(false);
    expect(answerSends(h.channel)).toHaveLength(0);
    const streamId = h.channel.streams[0]?.messageId;
    expect(streamId).toBeTruthy();

    h.channel.streamErrors.hangFinish = false;
    await recoverLink(h);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_hang') && entry.status === 'reply-delivered'
    )));
    expect(h.channel.updatedCards.some((row) => (
      row.messageId === streamId && JSON.stringify(row.card).includes(ANSWER)
    ))).toBe(true);
    expect(answerSends(h.channel)).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(1);
  });

  it('uses a stream uuid that is not the gone-card reply uuid', async () => {
    const h = await harness({ replyMode: 'markdown' });
    await h.channel.handlers.message?.(mention('om_uuid', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_uuid') && entry.status === 'reply-delivered'
    )));
    const entry = h.journal.list().find((item) => item.messageIds.includes('om_uuid'));
    const streamUuid = (h.channel.streams[0]?.options as { uuid?: string } | undefined)?.uuid;
    expect(streamUuid).toBe(`stream:${entry?.turnId}`);
    expect(streamUuid).not.toBe(entry?.reply?.deliveryId);
    expect(streamUuid?.length).toBeLessThanOrEqual(50);
  });

  it('does not mark a card run longer than 30s delivered when the final patch fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness({ replyMode: 'card', fakeTimers: true });
    h.channel.streamErrors.finish = sdkShapedSendError(
      'unknown',
      axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
    );

    await h.channel.handlers.message?.(mention('om_long', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await drainIO();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainIO();
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_long') && entry.status === 'completed-undelivered'
    )));
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_long') && entry.status === 'reply-delivered'
    ))).toBe(false);
    expect(answerSends(h.channel)).toHaveLength(0);
  });
});

async function harness(opts: {
  replyMode: 'card' | 'markdown';
  fakeTimers?: boolean;
  outboundTimeoutMs?: number;
}) {
  const tmp = await createTmpProfile('stream-delivery-');
  const file = join(tmp.profile, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  const cfg = profile(tmp.workspace, opts.replyMode);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: [[{
      type: 'text',
      delta: ANSWER,
    }, {
      type: 'final_text',
      content: ANSWER,
    }, {
      type: 'done',
      terminationReason: 'normal',
      resumeHandle: 'sess-1',
    }]],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    probe: async () => true,
    ...(opts.outboundTimeoutMs !== undefined ? { outboundTimeoutMs: opts.outboundTimeoutMs } : {}),
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-stream-delivery',
    },
  });
  if (opts.fakeTimers) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, journal };
}

function profile(workspace: string, replyMode: 'card' | 'markdown') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: replyMode,
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function answerSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER));
}

function noticeSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => {
    const json = JSON.stringify(item.content);
    return json.includes('notice.continue') || json.includes('上一轮未完成');
  });
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

async function recoverLink(h: {
  bridge: { tickLink(): Promise<void>; recoverMissed(): Promise<void> };
}) {
  await h.bridge.tickLink();
  await h.bridge.recoverMissed();
}

async function drainIO() {
  for (let n = 0; n < 50; n++) await yieldIO();
}

async function waitFor(predicate: () => boolean) {
  if (vi.isFakeTimers()) {
    for (let n = 0; n < 10_000; n++) {
      if (predicate()) return;
      await yieldIO();
    }
  } else {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('expected stream-delivery transition was not observed');
}
