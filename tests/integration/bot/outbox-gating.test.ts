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
  axiosLike,
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
const ANSWER = 'T13_FINAL';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('per-item outbox gating', { timeout: 20_000 }, () => {
  it('a final patch 4xxs once while the link stays up and the user still receives exactly one complete reply', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const h = await harness({
      replyMode: 'card',
      onRecovered: (outage) => recovered.push(outage),
    });
    recovered.length = 0;
    h.channel.streamErrors.finish = sdkShapedSendError('unknown', axiosHttpError(400));

    await h.channel.handlers.message?.(mention('om_up', 'please answer'));
    await waitFor(() => (
      h.journal.list().some((entry) => entry.messageIds.includes('om_up') && entry.reply?.state === 'sent')
      || h.channel.updatedCards.some((row) => JSON.stringify(row.card).includes(ANSWER))
    ));

    const streamId = h.channel.streams[0]?.messageId;
    expect(streamId).toBeTruthy();
    expect(answerSends(h.channel)).toHaveLength(0);
    expect(h.channel.updatedCards.some((row) => (
      row.messageId === streamId && JSON.stringify(row.card).includes(ANSWER)
    ))).toBe(true);
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_up') && entry.reply?.state === 'sent'
    ))).toBe(true);
    expect(recovered).toHaveLength(0);
    expect(h.channel.streams.length).toBe(1);
  });

  it('uuid-sends the stored deliveryId when a gone card can never be patched', async () => {
    const h = await harness({ replyMode: 'card' });
    h.channel.streamErrors.finish = sdkShapedSendError('unknown', axiosHttpError(400));
    h.channel.updateCard = async () => {
      throw sdkShapedSendError('unknown', axiosLike('message not found', {
        response: { status: 400, data: { code: 230025 } },
      }));
    };

    await h.channel.handlers.message?.(mention('om_gone', 'please answer'));
    await waitFor(() => answerSends(h.channel).length === 1);

    const entry = h.journal.list().find((item) => item.messageIds.includes('om_gone'));
    expect(entry?.reply?.state).toBe('sent');
    expect(entry?.reply?.deliveryId).toBeTruthy();
    expect((answerSends(h.channel)[0]?.options as { uuid?: string } | undefined)?.uuid).toBe(
      entry?.reply?.deliveryId,
    );
    expect(JSON.stringify(answerSends(h.channel)[0]?.content)).toContain(ANSWER);
    expect(h.channel.streams.length).toBe(1);
    expect(answerSends(h.channel)).toHaveLength(1);
  });

  it('makes zero send calls while the link is down at turn end, then exactly one after recovery', async () => {
    const h = await harness({ replyMode: 'text' });
    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();

    await h.channel.handlers.message?.(mention('om_down', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_down') && entry.reply?.state === 'staged'
    )));
    expect(answerSends(h.channel)).toHaveLength(0);

    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_down') && entry.reply?.state === 'sent'
    )));
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(JSON.stringify(answerSends(h.channel)[0]?.content)).toContain(ANSWER);
  });

  it('falls back to one plain-text send when a non-stream final 400 is rejected, without recovery', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const h = await harness({
      replyMode: 'text',
      onRecovered: (outage) => recovered.push(outage),
    });
    recovered.length = 0;
    const orig = h.channel.send.bind(h.channel);
    let failed = false;
    h.channel.send = async (chatId, content, options) => {
      if (!failed && !('text' in (content as object))) {
        failed = true;
        throw sdkShapedSendError('unknown', axiosHttpError(400));
      }
      return orig(chatId, content, options);
    };

    await h.channel.handlers.message?.(mention('om_400', 'please answer'));
    await waitFor(() => answerSends(h.channel).length === 1);

    expect(failed).toBe(true);
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(answerSends(h.channel)[0]?.content).toEqual({ text: ANSWER });
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_400') && (entry.reply?.state === 'sent' || entry.reply?.state === 'rejected')
    ))).toBe(true);
    expect(recovered).toHaveLength(0);
  });

  it('retries a local non-stream send while the link stays up until one complete reply lands', async () => {
    const recovered: Array<{ since: number; until: number }> = [];
    const h = await harness({
      replyMode: 'text',
      onRecovered: (outage) => recovered.push(outage),
    });
    recovered.length = 0;
    const orig = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      attempts += 1;
      if (attempts <= 2) {
        throw new TypeError('x is not a function');
      }
      return orig(...args);
    };

    await h.channel.handlers.message?.(mention('om_local', 'please answer'));
    await waitFor(() => answerSends(h.channel).length === 1);

    expect(attempts).toBeGreaterThan(2);
    expect(answerSends(h.channel)).toHaveLength(1);
    expect(JSON.stringify(answerSends(h.channel)[0]?.content)).toContain(ANSWER);
    expect(h.journal.list().some((entry) => (
      entry.messageIds.includes('om_local') && entry.reply?.state === 'sent'
    ))).toBe(true);
    expect(recovered).toHaveLength(0);
  });

  it('does not retry an ENETUNREACH final send until recovery delivers it once', async () => {
    const h = await harness({ replyMode: 'text' });
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      throw sdkShapedSendError(
        'unknown',
        axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
      );
    };

    await h.channel.handlers.message?.(mention('om_net', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_net') && entry.reply?.state === 'staged'
    )));
    expect(answerSends(h.channel)).toHaveLength(0);

    h.channel.send = orig;
    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_net') && entry.reply?.state === 'sent'
    )));
    expect(answerSends(h.channel)).toHaveLength(1);
  });
});

async function harness(opts: {
  replyMode: 'text' | 'card' | 'markdown';
  onRecovered?: (outage: { since: number; until: number }) => void;
}) {
  const tmp = await createTmpProfile('outbox-gating-');
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
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
    ...(opts.onRecovered ? { onRecovered: opts.onRecovered } : {}),
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-outbox-gating',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, journal };
}

function profile(workspace: string, replyMode: 'text' | 'card' | 'markdown') {
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

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected outbox-gating transition was not observed');
}
