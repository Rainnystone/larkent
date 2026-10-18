import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkChannelError } from '@larksuite/channel';
import { draftCardBodyFromCard } from '../../../src/automations/card-body';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import {
  automationSettledCard,
  DRAFT_SETTLED_END_CHOSEN,
  expireDueDraftCards,
  scheduleDraftCardSettle,
  settleDraftCard,
} from '../../../src/automations/draft-card';
import { automationEndCard, type EndCardTokens } from '../../../src/automations/end-card';
import type { Schedule } from '../../../src/automations/schedule';
import { AUTOMATIONS_DRAFT_TTL_MS, AutomationsStore } from '../../../src/automations/store';
import { CardKitApiError } from '../../../src/card/cardkit-update';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const CHAT = 'oc_group';
const NOW = Date.UTC(2026, 9, 18, 3, 0, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('draft card settle', () => {
  it('does not bump sequence or take the draft when cardkit update returns code != 0', async () => {
    const h = await harness();
    const draft = await h.store.saveDraft(reminder());
    const created = await h.channel.createCard(automationSettledCard('草稿'));
    const sent = await h.channel.send(CHAT, { cardId: created.cardId });
    await h.store.bindDraftCard(draft.draftId, sent.messageId, created.cardId);

    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 10004,
      msg: 'sequence invalid',
    });
    await expect(settleDraftCard(h.channel as never, h.store.getDraft(draft.draftId)!, '已取消', h.store))
      .rejects.toBeInstanceOf(CardKitApiError);
    expect(h.store.getDraft(draft.draftId)?.sequence).toBeUndefined();

    h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS + 1);
    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 10004,
      msg: 'sequence invalid',
    });
    await expireDueDraftCards({ store: h.store, channel: h.channel as never });
    expect(h.store.getDraft(draft.draftId)?.cardMessageId).toBe(sent.messageId);
    expect(h.store.getDraft(draft.draftId)?.sequence).toBeUndefined();
    expect(await draftFailEntries(h.logsDir)).toEqual([
      expect.objectContaining({ code: 10004, msg: 'sequence invalid' }),
    ]);
  });

  it('drops an expired draft once when the card is gone, recalled, or not permitted', async () => {
    const h = await harness();
    const recalled = await h.store.saveDraft(reminder());
    const recalledCard = await h.channel.createCard(automationSettledCard('草稿'));
    const recalledSent = await h.channel.send(CHAT, { cardId: recalledCard.cardId });
    await h.store.bindDraftCard(recalled.draftId, recalledSent.messageId, recalledCard.cardId);
    const denied = await h.store.saveDraft(reminder());
    const deniedCard = await h.channel.createCard(automationSettledCard('草稿'));
    const deniedSent = await h.channel.send(CHAT, { cardId: deniedCard.cardId });
    await h.store.bindDraftCard(denied.draftId, deniedSent.messageId, deniedCard.cardId);
    h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS + 1);

    const updates: Record<string, number> = {};
    const orig = h.channel.rawClient.cardkit.v1.card.update;
    h.channel.rawClient.cardkit.v1.card.update = async (params) => {
      const path = (params as { path?: { card_id?: string } } | undefined)?.path;
      const cardId = typeof path?.card_id === 'string' ? path.card_id : '';
      updates[cardId] = (updates[cardId] ?? 0) + 1;
      if (cardId === recalledCard.cardId) {
        return { code: 230026, msg: 'message recalled' };
      }
      throw new LarkChannelError('permission_denied', 'no access');
    };
    await expireDueDraftCards({ store: h.store, channel: h.channel as never });
    await expireDueDraftCards({ store: h.store, channel: h.channel as never });
    h.channel.rawClient.cardkit.v1.card.update = orig;
    expect(h.store.getDraft(recalled.draftId)).toBeUndefined();
    expect(h.store.getDraft(denied.draftId)).toBeUndefined();
    expect(updates[recalledCard.cardId]).toBe(1);
    expect(updates[deniedCard.cardId]).toBe(1);
    const fails = await draftFailEntries(h.logsDir);
    expect(fails).toHaveLength(2);
    expect(fails[0]).toEqual(expect.objectContaining({ code: 230026, msg: 'message recalled' }));
  });

  it('keeps an expired draft when settle hits a transient link error', async () => {
    const h = await harness();
    const draft = await h.store.saveDraft(reminder());
    const created = await h.channel.createCard(automationSettledCard('草稿'));
    const sent = await h.channel.send(CHAT, { cardId: created.cardId });
    await h.store.bindDraftCard(draft.draftId, sent.messageId, created.cardId);
    h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS + 1);
    h.channel.rawClient.cardkit.v1.card.update = async () => {
      throw axiosErrno('ECONNRESET', 'connect ECONNRESET');
    };
    await expireDueDraftCards({ store: h.store, channel: h.channel as never });
    expect(h.store.getDraft(draft.draftId)?.cardMessageId).toBe(sent.messageId);
  });

  it('retries a few times when settling a tapped card hits a transient error', async () => {
    const h = await harness();
    const draft = await h.store.saveDraft(reminder());
    const created = await h.channel.createCard(automationSettledCard('草稿'));
    const sent = await h.channel.send(CHAT, { cardId: created.cardId });
    await h.store.bindDraftCard(draft.draftId, sent.messageId, created.cardId);
    const snapshot = h.store.getDraft(draft.draftId)!;
    await h.store.takeDraft(draft.draftId);
    let attempts = 0;
    const origUpdate = h.channel.rawClient.cardkit.v1.card.update.bind(h.channel.rawClient.cardkit.v1.card);
    h.channel.rawClient.cardkit.v1.card.update = async (params) => {
      attempts += 1;
      if (attempts < 3) throw axiosErrno('ECONNRESET', 'connect ECONNRESET');
      return origUpdate(params);
    };
    vi.useFakeTimers();
    try {
      scheduleDraftCardSettle(h.channel as never, snapshot, '已确认 #1');
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    expect(attempts).toBe(3);
    expect(JSON.stringify(h.channel.updatedCards.at(-1)?.card)).toContain('已确认 #1');
  });

  it('bumps sequence after a successful settle and does not write it onto a rebound card', async () => {
    const h = await harness();
    const draft = await h.store.saveDraft(reminder());
    const endCard = await h.channel.createCard(automationSettledCard('指定结束时间'));
    const endSent = await h.channel.send(CHAT, { cardId: endCard.cardId });
    await h.store.bindDraftCard(draft.draftId, endSent.messageId, endCard.cardId);
    const snapshot = h.store.getDraft(draft.draftId)!;

    const confirmCard = await h.channel.createCard(automationSettledCard('确认'));
    const confirmSent = await h.channel.send(CHAT, { cardId: confirmCard.cardId });
    await h.store.bindDraftCard(draft.draftId, confirmSent.messageId, confirmCard.cardId);

    await settleDraftCard(h.channel as never, snapshot, '已指定结束时间', h.store);
    expect(h.store.getDraft(draft.draftId)?.cardId).toBe(confirmCard.cardId);
    expect(h.store.getDraft(draft.draftId)?.sequence).toBeUndefined();
    expect(JSON.stringify(h.channel.updatedCards.at(-1)?.card)).toContain('已指定结束时间');

    await settleDraftCard(h.channel as never, h.store.getDraft(draft.draftId)!, '已确认 #1', h.store);
    expect(h.store.getDraft(draft.draftId)?.sequence).toBe(1);
  });

  it('keeps the registered card body after the draft is consumed and the task is deleted', async () => {
    const h = await harness();
    const cardNow = NOW - 5 * 24 * 60 * 60_000;
    const card = automationConfirmCard({
      taskType: 'reminder',
      name: '交周报',
      taskText: '卡片正文标记-周报',
      timezone: 'Asia/Shanghai',
      schedule: weekday(cardNow),
      now: cardNow,
      confirmToken: 'auto_cb.v1.confirm-secret',
      rejectToken: 'auto_cb.v1.reject-secret',
    });
    const originalFires = fireLines(card);
    const laterFires = fireLines(automationConfirmCard({
      taskType: 'reminder',
      name: '交周报',
      taskText: '卡片正文标记-周报',
      timezone: 'Asia/Shanghai',
      schedule: weekday(cardNow),
      now: NOW + 30 * 24 * 60 * 60_000,
      confirmToken: 'auto_cb.v1.confirm-secret',
      rejectToken: 'auto_cb.v1.reject-secret',
    }));
    expect(laterFires[0]).not.toBe(originalFires[0]);

    const draft = await h.store.saveDraft(reminder());
    const created = await h.channel.createCard(card);
    const sent = await h.channel.send(CHAT, { cardId: created.cardId });
    const body = draftCardBodyFromCard(card);
    expect(body, 'card registration stores the rendered body').toBeDefined();
    await h.store.bindDraftCard(draft.draftId, sent.messageId, created.cardId, body);

    const persisted = await readFile(join(h.dir, 'automations.json'), 'utf8');
    expect(persisted).not.toContain('auto_cb.v1.confirm-secret');
    expect(persisted).toContain('卡片正文标记-周报');

    const reloaded = new AutomationsStore({
      path: join(h.dir, 'automations.json'),
      logPath: join(h.dir, 'automations.log'),
      statusPath: join(h.dir, 'automations-status.json'),
      now: () => NOW + 30 * 24 * 60 * 60_000,
    });
    await reloaded.load();
    const item = await reloaded.create({
      ...reminder(),
      name: '已删除的任务',
      taskText: '任务已删除标记',
    });
    expect(await reloaded.delete(item.id)).toBe(true);
    const taken = await reloaded.takeDraft(draft.draftId);
    expect(taken).toBeDefined();
    expect(reloaded.getDraft(draft.draftId)).toBeUndefined();
    expect(reloaded.get(item.id)).toBeUndefined();

    await settleDraftCard(h.channel as never, taken!, '已确认 #7', reloaded);
    const settled = JSON.stringify(h.channel.updatedCards.at(-1)?.card);
    expect(fireLines(JSON.parse(settled) as object)).toEqual(originalFires);
    expect(settled).toContain('卡片正文标记-周报');
    expect(settled).toContain('每个工作日 09:30');
    expect(settled).not.toContain('任务已删除标记');
    expect(settled).not.toContain('一次性');
    expect(settled).not.toContain('"tag":"button"');
    expect(settled).not.toContain('auto_cb.v1');
    expect(markdownContents(settled).filter((text) => text === '已确认 #7')).toEqual(['已确认 #7']);
    expect(topTags(settled)).toEqual(['markdown', 'hr', 'markdown']);
  });

  it('keeps the end-card prompt when settle uses the pre-rebind snapshot', async () => {
    const h = await harness();
    const end = automationEndCard(END_TOKENS);
    const confirm = automationConfirmCard({
      taskType: 'reminder',
      name: '不该出现的确认正文',
      taskText: '确认卡任务原文',
      timezone: 'Asia/Shanghai',
      schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
      now: NOW,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    });
    const draft = await h.store.saveDraft(reminder());
    const endCreated = await h.channel.createCard(end);
    const endSent = await h.channel.send(CHAT, { cardId: endCreated.cardId });
    await h.store.bindDraftCard(
      draft.draftId,
      endSent.messageId,
      endCreated.cardId,
      draftCardBodyFromCard(end),
    );
    const snapshot = h.store.getDraft(draft.draftId)!;
    const confirmCreated = await h.channel.createCard(confirm);
    const confirmSent = await h.channel.send(CHAT, { cardId: confirmCreated.cardId });
    await h.store.bindDraftCard(
      draft.draftId,
      confirmSent.messageId,
      confirmCreated.cardId,
      draftCardBodyFromCard(confirm),
    );

    await settleDraftCard(h.channel as never, snapshot, DRAFT_SETTLED_END_CHOSEN, h.store);
    const settled = JSON.stringify(h.channel.updatedCards.at(-1)?.card);
    expect(settled).toContain('周期任务必须指定结束时间。请选择常用时长，或输入结束日期。');
    expect(settled).not.toContain('不该出现的确认正文');
    expect(settled).not.toContain('确认卡任务原文');
    expect(settled).not.toContain('一个月');
    expect(settled).not.toContain('end_at');
    expect(settled).not.toContain('"tag":"button"');
    expect(settled).not.toContain('"tag":"form"');
    expect(markdownContents(settled).filter((text) => text === '已指定结束时间')).toEqual(['已指定结束时间']);
    expect(topTags(settled)).toEqual(['markdown', 'markdown', 'hr']);
    expect(h.channel.updatedCards.at(-1)?.messageId).toBe(endSent.messageId);
  });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-draft-settle-'));
  dirs.push(dir);
  const logsDir = join(dir, 'logs');
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  let nowMs = NOW;
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: () => nowMs,
  });
  await store.load();
  return {
    dir,
    logsDir,
    store,
    channel: createFakeChannel(),
    setNow(next: number) {
      nowMs = next;
    },
  };
}

const END_TOKENS: EndCardTokens = {
  'auto.end.1m': 'auto_cb.v1.1m',
  'auto.end.3m': 'auto_cb.v1.3m',
  'auto.end.eoy': 'auto_cb.v1.eoy',
  'auto.end.1y': 'auto_cb.v1.1y',
  'auto.end.custom': 'auto_cb.v1.custom',
  'auto.reject': 'auto_cb.v1.reject',
};

function weekday(startAt: number): Schedule {
  return {
    kind: 'weekday',
    timezone: 'Asia/Shanghai',
    times: [{ hour: 9, minute: 30 }],
    startAt,
    endAt: NOW + 120 * 24 * 60 * 60_000,
  };
}

function fireLines(card: object): string[] {
  return markdownContents(JSON.stringify(card))
    .join('\n')
    .split('\n')
    .filter((line) => /^- \d{4}-\d{2}-\d{2}/.test(line));
}

function markdownContents(cardJson: string): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as { tag?: unknown; content?: unknown };
    if (rec.tag === 'markdown' && typeof rec.content === 'string') texts.push(rec.content);
    for (const value of Object.values(rec)) walk(value);
  };
  walk(JSON.parse(cardJson) as unknown);
  return texts;
}

function topTags(cardJson: string): string[] {
  const card = JSON.parse(cardJson) as { body?: { elements?: Array<{ tag?: string }> } };
  return (card.body?.elements ?? []).map((element) => element.tag ?? '');
}

function reminder() {
  return {
    taskType: 'reminder' as const,
    schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW,
    endAt: NOW + 60 * 60_000,
    nextFireAt: NOW + 60 * 60_000,
    chatId: CHAT,
    createdBy: 'ou_user',
    name: '交周报',
    taskText: '提醒交周报',
  };
}

async function draftFailEntries(logsDir: string): Promise<Array<{ code?: unknown; msg?: unknown }>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as {
    phase?: string;
    _event?: string;
    code?: unknown;
    msg?: unknown;
  }).filter((entry) => entry.phase === 'auto' && entry._event === 'draft-card');
}
