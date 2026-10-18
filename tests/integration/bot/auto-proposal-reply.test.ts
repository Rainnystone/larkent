import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { AutomationsStore } from '../../../src/automations/store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
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
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');
const CONFIRM_LINE = '已生成确认卡，点「是」后生效。';
const PLAIN = '好的，我先看一下这个时间。';
const CLAIMED = '已提交本群定时提醒「交周报」。';
const BAD_SCHEDULE = '今天 15:50 运行一次';
const REJECT_LINE = `⚠️ 没有创建任务：无法解析时间表「${BAD_SCHEDULE}」。可写成「明天 09:00」「2026-10-18 15:50」「10 分钟后」。`;
const TASK = '提醒我交周报';
const NAME = '交周报';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
  await closeLogger();
});

for (const replyMode of ['text', 'card'] as const) {
  describe(`A24 ${replyMode} reply`, () => {
    it('keeps an illegal proposal to one reply that already contains the reason', async () => {
      const h = await harness({
        replyMode,
        events: [
          { type: 'text', delta: `${PLAIN}\n${proposalXml(BAD_SCHEDULE)}` },
          { type: 'done', terminationReason: 'normal' },
        ],
      });

      await h.channel.handlers.message?.(mention('om_bad', '今天 15:50 运行一次'));
      await waitFor(async () => (await chatContents(h)).some((body) => body.includes('无法解析时间表')));

      const contents = await chatContents(h);
      const replies = contents.filter((body) => !body.includes('auto.confirm') && !body.includes('auto.end.'));
      expect(replies).toHaveLength(1);
      const text = replyText(replies[0] ?? '');
      expect(text).toContain(REJECT_LINE);
      expect(text).toContain(PLAIN);
      expect(text).not.toContain('已提交');
      expect(text).not.toContain('已创建');
      expect(text).not.toContain('已设置');
      expect(text).not.toContain('automation_proposal');
      expect(contents.some((body) => replyText(body).trim() === '无法解析时间表。')).toBe(false);
      expect(contents.some((body) => body.includes('auto.confirm'))).toBe(false);
      expect(h.store.listDrafts()).toEqual([]);

      const delivery = deliveryOf(h, REJECT_LINE);
      expect(payloadOf(delivery)).toContain(PLAIN);
      expect(payloadOf(delivery)).toContain(BAD_SCHEDULE);

      const rejected = await logEvents(h.logsDir, 'rejected');
      expect(rejected).toEqual([
        expect.objectContaining({
          phase: 'auto',
          event: 'rejected',
          reason: 'invalid-schedule',
          source: 'proposal',
        }),
      ]);
      const blob = JSON.stringify(rejected);
      expect(blob).not.toContain(BAD_SCHEDULE);
      expect(blob).not.toContain(TASK);
      expect(blob).not.toContain(NAME);
    }, 15_000);

    it('appends the confirm line before the card and leaves a model claim in place', async () => {
      const h = await harness({
        replyMode,
        events: [
          { type: 'text', delta: `${CLAIMED}\n${proposalXml('10 分钟后')}` },
          { type: 'done', terminationReason: 'normal' },
        ],
      });

      await h.channel.handlers.message?.(mention('om_ok', '10 分钟后提醒我交周报'));
      await waitFor(async () => (await chatContents(h)).some((body) => body.includes('auto.confirm')));

      const contents = await chatContents(h);
      const replies = contents.filter((body) => !body.includes('auto.confirm'));
      expect(replies).toHaveLength(1);
      const text = replyText(replies[0] ?? '');
      expect(text).toContain(CLAIMED);
      expect(text.endsWith(CONFIRM_LINE)).toBe(true);
      expect(text).not.toContain('automation_proposal');

      const replyAt = contents.findIndex((body) => body.includes(CONFIRM_LINE) && !body.includes('auto.confirm'));
      const cardAt = contents.findIndex((body) => body.includes('auto.confirm'));
      expect(replyAt).toBeGreaterThanOrEqual(0);
      expect(cardAt).toBeGreaterThan(replyAt);

      const delivery = deliveryOf(h, CONFIRM_LINE);
      expect(payloadOf(delivery)).toContain(CLAIMED);
      const deliveryAt = h.channel.callLog.indexOf(delivery);
      const cardSendAt = h.channel.callLog.findIndex((op) => (
        op.op === 'send' && JSON.stringify(op).includes('auto.confirm')
      ));
      expect(cardSendAt).toBeGreaterThan(deliveryAt);
      expect(h.store.listDrafts()).toHaveLength(1);
      expect(await logEvents(h.logsDir, 'rejected')).toEqual([]);
    }, 15_000);

    it('uses only the appended line when the model emits no prose', async () => {
      const h = await harness({
        replyMode,
        events: [
          { type: 'text', delta: proposalXml('10 分钟后') },
          { type: 'done', terminationReason: 'normal' },
        ],
      });

      await h.channel.handlers.message?.(mention('om_empty', '10 分钟后提醒我交周报'));
      await waitFor(async () => {
        const contents = await chatContents(h);
        return contents.some((body) => replyText(body).trim() === CONFIRM_LINE)
          && contents.some((body) => body.includes('auto.confirm'));
      });

      const contents = await chatContents(h);
      const replies = contents.filter((body) => !body.includes('auto.confirm'));
      expect(replies).toHaveLength(1);
      expect(replyText(replies[0] ?? '').trim()).toBe(CONFIRM_LINE);
      const cardAt = contents.findIndex((body) => body.includes('auto.confirm'));
      const replyAt = contents.findIndex((body) => body.includes(CONFIRM_LINE) && !body.includes('auto.confirm'));
      expect(cardAt).toBeGreaterThan(replyAt);
    }, 15_000);

    it('uses only the rejection line when the model emits no prose', async () => {
      const h = await harness({
        replyMode,
        events: [
          { type: 'text', delta: proposalXml(BAD_SCHEDULE) },
          { type: 'done', terminationReason: 'normal' },
        ],
      });

      await h.channel.handlers.message?.(mention('om_empty_bad', '今天 15:50 运行一次'));
      await waitFor(async () => (await chatContents(h)).some((body) => body.includes(REJECT_LINE)));

      const contents = await chatContents(h);
      const replies = contents.filter((body) => !body.includes('auto.confirm') && !body.includes('auto.end.'));
      expect(replies).toHaveLength(1);
      expect(replyText(replies[0] ?? '').trim()).toBe(REJECT_LINE);
      expect(contents.some((body) => body.includes('auto.confirm'))).toBe(false);
      expect(h.store.listDrafts()).toEqual([]);
    }, 15_000);
  });
}

async function harness(opts: {
  events: FakeAgentEvents;
  replyMode: 'text' | 'card';
}) {
  const tmp = await createTmpProfile('auto-a24-');
  const mediaDir = join(tmp.profile, 'media');
  const logsDir = join(tmp.profile, 'logs');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  const now = () => NOW;
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  await store.load();
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: opts.replyMode,
      messageReplyMigrated: true,
      cotMessages: 'off',
    },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude', events: opts.events });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
    journal,
    now,
    probe: async () => true,
    appPaths: {
      mediaDir,
      logsDir,
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
      processId: 'test-auto-a24',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    // Windows fs.rm does not settle while this process still holds the log
    // stream. Close it before the profile directory is removed.
    await closeLogger();
    await tmp.cleanup();
  });
  return { channel, store, logsDir, bridge };
}

function proposalXml(schedule: string): string {
  return `<automation_proposal>\n${JSON.stringify({
    taskType: 'reminder',
    schedule,
    name: NAME,
    taskText: TASK,
  })}\n</automation_proposal>`;
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

async function chatContents(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): Promise<string[]> {
  const listed = await h.channel.rawClient.im.v1.message.list({
    params: { container_id_type: 'chat', container_id: CHAT, page_size: 50 },
  }) as { data?: { items?: Array<{ body?: { content?: string } }> } };
  return (listed.data?.items ?? []).map((item) => item.body?.content ?? '');
}

function replyText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  return markdownPieces(parsed).join('\n').trim();
}

function markdownPieces(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(markdownPieces);
  if (!value || typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  if (typeof rec.markdown === 'string') return [rec.markdown];
  const nested: string[] = [];
  if (rec.tag === 'markdown' && typeof rec.content === 'string') nested.push(rec.content);
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'markdown' || (key === 'content' && rec.tag === 'markdown')) continue;
    nested.push(...markdownPieces(child));
  }
  return nested;
}

function deliveryOf(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  needle: string,
): ReturnType<typeof createRecordingLarkChannel>['callLog'][number] {
  const found = h.channel.callLog.find((op) => JSON.stringify(op).includes(needle));
  expect(found, `expected a delivery containing ${needle}`).toBeDefined();
  return found!;
}

function payloadOf(op: ReturnType<typeof createRecordingLarkChannel>['callLog'][number]): string {
  return JSON.stringify(op);
}

async function logEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('timed out waiting for the automation reply');
}
