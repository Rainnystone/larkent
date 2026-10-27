import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_END_BUSY,
  AUTO_INTERVAL_TOO_SMALL,
  AUTO_INVALID_END,
  AUTO_INVALID_HINT,
} from '../../../src/automations/command';
import { AutomationsStore } from '../../../src/automations/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { expectSettledKeepsBody } from '../../helpers/settled-oneshot';
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
const MATE = 'ou_mate';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const WEEKDAY_FIRES = [
  Date.UTC(2026, 9, 19, 1, 0, 0),
  Date.UTC(2026, 9, 20, 1, 0, 0),
  Date.UTC(2026, 9, 21, 1, 0, 0),
] as const;
const LAST_FIRE = WEEKDAY_FIRES[2];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('A2 recurring creation and expiry', () => {
  it.each(['in 15m', '每个工作日 09:00'])('keeps a manual %s draft card in its originating topic', async schedule => {
    const h = await harness({ chatMode: 'topic' });
    await h.channel.handlers.message?.({ ...mention('om_topic', `/auto new ${schedule} | 话题提醒 | 提醒`), threadId: 'omt_topic' });
    const card = h.channel.sent.find(item => JSON.stringify(item.content).includes(schedule === 'in 15m' ? 'auto.confirm' : 'auto.end.'));
    expect(card?.options).toMatchObject({ replyTo: 'om_topic', replyInThread: true });
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeTypeOf('string');
    if (schedule !== 'in 15m') {
      const draft = h.store.listDrafts()[0]!;
      const endCard = JSON.stringify(card!.content);
      await h.channel.handlers.cardAction?.(cardClick(MATE, tokenFor(endCard, 'auto.end.1w'), draft.cardMessageId!, 'auto.end.1w'));
      const confirm = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'));
      expect(confirm?.options).toMatchObject({ replyTo: draft.cardMessageId, replyInThread: true });
    }
  });

  it('asks for an end on a weekday draft, then confirms, fires the last catch-up, and expires off the status file', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));

    const endCard = cardContaining(h, 'auto.end.');
    expect(endCard).toContain('一周');
    expect(endCard).toContain('两周');
    expect(endCard).toContain('一个月');
    expect(endCard).toContain('三个月');
    expect(endCard).toContain('今年年底');
    expect(endCard).toContain('一年');
    expect(endCard).toContain('end_at');
    expect(endCard).not.toContain('auto.confirm');
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toHaveLength(1);

    await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      tokenFor(endCard, 'auto.end.custom'),
      h.store.listDrafts()[0]!.cardMessageId!,
      'auto.end.custom',
      { end_at: '2026-10-21' },
    ));

    const confirm = confirmCard(h);
    expect(confirm).toContain('工作日不计调休');
    expect(confirm).toContain('2026-10-19 09:00');
    expect(confirm).toContain('2026-10-20 09:00');
    expect(confirm).toContain('2026-10-21 09:00');
    expect(confirm).toContain('提醒站会');
    expect(confirm).toContain('Asia/Shanghai');

    await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      confirmToken(confirm),
      h.store.listDrafts()[0]!.cardMessageId!,
    ));
    expect(h.store.list()[0]).toMatchObject({
      id: 1,
      taskType: 'reminder',
      name: '站会',
      taskText: '提醒站会',
      timezone: 'Asia/Shanghai',
      nextFireAt: WEEKDAY_FIRES[0],
    });

    h.setNow(LAST_FIRE + 1);
    await h.restart();

    expect(h.store.list()).toEqual([]);
    const status = JSON.parse(await readFile(h.statusPath, 'utf8')) as {
      items: Array<{ id: number }>;
    };
    expect(status.items).toEqual([]);
    const log = await h.store.readLog();
    expect(log.some((entry) => entry.result === 'catch-up' && entry.scheduledAt === LAST_FIRE)).toBe(true);
    expect(log.filter((entry) => entry.result === 'missed')).toHaveLength(2);
  });

  it('keeps the custom-end token after empty or typo end_at so a later submit on the same card works', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));
    const endCard = cardContaining(h, 'auto.end.');
    const token = tokenFor(endCard, 'auto.end.custom');
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;

    const empty = await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token,
      messageId,
      'auto.end.custom',
      { end_at: '' },
    ));
    expect(empty).toEqual({ toast: { type: 'error', content: AUTO_INVALID_END } });
    expect(h.store.listDrafts()).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent)).not.toContain('auto.confirm');

    const typo = await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token,
      messageId,
      'auto.end.custom',
      { end_at: '2026-02-31' },
    ));
    expect(typo).toEqual({ toast: { type: 'error', content: AUTO_INVALID_END } });

    await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token,
      messageId,
      'auto.end.custom',
      { end_at: '2026-10-21' },
    ));
    expect(confirmCard(h)).toContain('auto.confirm');
    expect(pendingOf(h.store.listDrafts()[0])).toBeUndefined();
  });

  it('lets one of two concurrent end-card taps win and keeps a typo retryable', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));
    const endCard = cardContaining(h, 'auto.end.');
    const token = tokenFor(endCard, 'auto.end.custom');
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    const click = (operatorId: string, endAt: string) => h.channel.handlers.cardAction?.(cardClick(
      operatorId,
      token,
      messageId,
      'auto.end.custom',
      { end_at: endAt },
    ));

    const [first, second] = await Promise.all([
      click(MATE, '2026-10-21'),
      click(USER, '2026-11-21'),
    ]);
    const toasts = [first, second];
    expect(toasts.filter((toast) => toastEqual(toast, 'success', '已指定结束时间'))).toHaveLength(1);
    expect(toasts.filter((toast) => toastEqual(toast, 'error', AUTO_END_BUSY))).toHaveLength(1);

    const bodies = h.channel.sent.map((item) => JSON.stringify(item.content));
    expect(bodies.filter((body) => body.includes('auto.confirm'))).toHaveLength(1);
    expect(bodies.some((body) => body.includes(AUTO_END_BUSY))).toBe(false);
    expect(h.store.listDrafts()).toHaveLength(1);
    expect(pendingOf(h.store.listDrafts()[0])).toBeUndefined();
    const confirm = confirmCard(h);
    const winners = [confirm.includes('2026-10-21'), confirm.includes('2026-11-21')].filter(Boolean);
    expect(winners).toHaveLength(1);

    const replay = await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token,
      messageId,
      'auto.end.custom',
      { end_at: '2026-12-21' },
    ));
    expect(replay).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);

    const retry = await harness();
    await retry.channel.handlers.message?.(mention('om_typo', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));
    const retryCard = cardContaining(retry, 'auto.end.');
    const retryToken = tokenFor(retryCard, 'auto.end.custom');
    const retryMessage = retry.store.listDrafts()[0]!.cardMessageId!;
    const retryTypo = await retry.channel.handlers.cardAction?.(cardClick(
      MATE,
      retryToken,
      retryMessage,
      'auto.end.custom',
      { end_at: '2026-02-31' },
    ));
    expect(retryTypo).toEqual({ toast: { type: 'error', content: AUTO_INVALID_END } });
    await retry.channel.handlers.cardAction?.(cardClick(
      USER,
      retryToken,
      retryMessage,
      'auto.end.custom',
      { end_at: '2026-10-21' },
    ));
    expect(confirmCard(retry)).toContain('auto.confirm');
    expect(pendingOf(retry.store.listDrafts()[0])).toBeUndefined();
  });

  it('turns one preset tap into a confirm card and ignores a second tap on the same card', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));
    const endCard = cardContaining(h, 'auto.end.1m');
    const token = tokenFor(endCard, 'auto.end.1m');
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;

    const updatesBefore = h.channel.updatedCards.length;
    const chosen = await h.channel.handlers.cardAction?.(cardClick(MATE, token, messageId, 'auto.end.1m'));
    expect(chosen).toEqual({ toast: { type: 'success', content: '已指定结束时间' } });
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(confirmCard(h)).toContain('auto.confirm');
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
    await waitFor(() => settledCardUpdates(h).some((text) => text.includes('已指定结束时间')));
    const settled = latestSettledCard(h);
    expectSettledKeepsBody({
      settledJson: settled,
      originalJson: endCard,
      status: '已指定结束时间',
      absent: ['auto.end.', 'auto.reject', '一周', '一个月', 'end_at', MATE, 'Op', USER],
    });

    const second = await h.channel.handlers.cardAction?.(cardClick(USER, token, messageId, 'auto.end.1m'));
    expect(second).toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  });

  it('discards the end-card draft when 取消 is tapped', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_new', '/auto new 每个工作日 09:00 | 站会 | 提醒站会'));
    const endCard = cardContaining(h, 'auto.end.1m');
    const messageId = h.store.listDrafts()[0]!.cardMessageId!;
    const updatesBefore = h.channel.updatedCards.length;
    const rejected = await h.channel.handlers.cardAction?.(
      cardClick(MATE, tokenFor(endCard, 'auto.reject'), messageId, 'auto.reject'),
    );
    expect(rejected).toEqual({ toast: { type: 'success', content: '已取消' } });
    expect(h.channel.updatedCards).toHaveLength(updatesBefore);
    expect(h.store.list()).toEqual([]);
    expect(h.store.listDrafts()).toEqual([]);
    await waitFor(() => settledCardUpdates(h).some((text) => text.includes('已取消')));
    const settled = latestSettledCard(h);
    expectSettledKeepsBody({
      settledJson: settled,
      originalJson: endCard,
      status: '已取消',
      absent: ['auto.end.', 'auto.reject', '一周', '一个月', 'end_at', MATE, 'Op', USER],
    });
  });

  it('rejects a reminder interval under 10 minutes and an agent-task interval under 1 hour', async () => {
    const h = await harness({ agentTasks: true });
    await h.channel.handlers.message?.(mention('om_soon', '/auto new every 5m | 吵 | ping'));
    expect(lastMarkdown(h.channel)).toBe(AUTO_INTERVAL_TOO_SMALL);
    expect(h.store.listDrafts()).toEqual([]);

    await h.channel.handlers.message?.(mention('om_agent', '/auto new agent every 30m | 汇总 | 跑 issue'));
    expect(lastMarkdown(h.channel)).toBe(AUTO_INTERVAL_TOO_SMALL);
    expect(h.store.list()).toEqual([]);
  });
});

function pendingOf(
  draft: { op: 'create' | 'delete' | 'replace'; pendingRecurring?: { kind: string } } | undefined,
): { kind: string } | undefined {
  if (!draft || draft.op === 'delete') return undefined;
  return draft.pendingRecurring;
}

async function harness(opts: { agentTasks?: boolean; chatMode?: 'group' | 'topic' } = {}) {
  const tmp = await createTmpProfile('auto-recurring-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  let nowMs = NOW;
  const now = () => nowMs;
  const statusPath = join(tmp.profile, 'automations-status.json');
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath,
    now,
  });
  await store.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedUsers: [USER, MATE],
      allowedChats: [CHAT],
    },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
    },
  });
  cfg.automations = {
    enabled: true,
    agentTasks: opts.agentTasks ?? false,
    timezone: 'Asia/Shanghai',
  };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude' });

  const start = async () => {
    const channel = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      chatMode: opts.chatMode ?? 'group',
      botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
    });
    sdk.channel = channel;
    const bridge = await startChannel({
      cfg,
      agent,
      sessions,
      workspaces,
      automations: store,
      now,
      probe: async () => true,
      appPaths: {
        mediaDir,
        secretsFile: join(tmp.profile, 'secrets.enc'),
        keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
      },
      controls: {
        profile: 'test',
        profileConfig: cfg,
        cfg,
        botOwnerId: 'ou_owner',
        ownerRefreshState: 'ok',
        async refreshOwner() {},
        async restart() {},
        async exit() {},
        configPath: join(tmp.root, 'config.json'),
        processId: 'test-auto-recurring',
      },
    });
    return { channel, bridge };
  };

  let live = await start();
  cleanups.push(async () => {
    await live.bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await tmp.cleanup();
  });
  return {
    get channel() {
      return live.channel;
    },
    store,
    statusPath,
    setNow(next: number) {
      nowMs = next;
    },
    async restart() {
      await live.bridge.disconnect();
      live = await start();
    },
  };
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
    createTime: NOW,
    raw: { sender: { sender_type: 'user', sender_id: { open_id: USER } } },
  } as unknown as NormalizedMessage;
}

function cardContaining(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  needle: string,
): string {
  const send = [...h.channel.sent].reverse().find((item) => JSON.stringify(item.content).includes(needle));
  expect(send, `expected chat content containing ${needle}`).toBeDefined();
  return JSON.stringify(send?.content);
}

function confirmCard(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  return cardContaining(h, 'auto.confirm');
}

function confirmToken(cardJson: string): string {
  return tokenFor(cardJson, 'auto.confirm');
}

function tokenFor(cardJson: string, cmd: string): string {
  const match = cardJson.match(new RegExp(`"cmd":"${cmd}","auto_token":"(auto_cb\\.v[0-9]+\\.[^"]+)"`));
  expect(match?.[1], `expected ${cmd} token`).toBeDefined();
  return match![1]!;
}

function cardClick(
  operatorId: string,
  token: string,
  messageId: string,
  cmd: string = 'auto.confirm',
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value: { cmd, auto_token: token } },
    chatId: CHAT,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
    ...(formValue ? { raw: { action: { form_value: formValue } } } : {}),
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: ReturnType<typeof createRecordingLarkChannel>): string {
  const send = [...channel.sent].reverse().find((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string';
  });
  expect(send, 'expected a markdown reply').toBeDefined();
  return (send!.content as { markdown: string }).markdown;
}

function toastEqual(toast: unknown, type: 'success' | 'error', content: string): boolean {
  return JSON.stringify(toast) === JSON.stringify({ toast: { type, content } });
}

function settledCardUpdates(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.updatedCards
    .map((item) => JSON.stringify(item.card))
    .filter((text) => (
      text.includes('已确认 #')
      || text.includes('已取消')
      || text.includes('已过期')
      || text.includes('已指定结束时间')
    ));
}

function latestSettledCard(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  const text = [...settledCardUpdates(h)].at(-1);
  expect(text, 'expected a settled one-shot card update').toBeDefined();
  return text!;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
