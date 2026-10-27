import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { parseScheduleText, presetEndAt } from '../../../src/automations/command';
import { completeDraftEnd, resolveEndAt } from '../../../src/automations/draft-confirmation';
import { END_CARD_PRESETS, automationEndCard, type EndCardTokens } from '../../../src/automations/end-card';
import { AutomationsStore } from '../../../src/automations/store';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createFakeChannel } from '../../helpers/fake-channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const WEEK_END = Date.UTC(2026, 9, 24, 3, 0, 0);
const TWO_WEEK_END = Date.UTC(2026, 9, 31, 3, 0, 0);

const TOKENS: EndCardTokens = {
  'auto.end.1w': 'auto_cb.v1.1w',
  'auto.end.2w': 'auto_cb.v1.2w',
  'auto.end.1m': 'auto_cb.v1.1m',
  'auto.end.3m': 'auto_cb.v1.3m',
  'auto.end.eoy': 'auto_cb.v1.eoy',
  'auto.end.1y': 'auto_cb.v1.1y',
  'auto.end.custom': 'auto_cb.v1.custom',
  'auto.reject': 'auto_cb.v1.reject',
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('end-card presets', () => {
  it('lists six duration presets from shortest to longest', () => {
    expect(END_CARD_PRESETS.map((preset) => ({ cmd: preset.cmd, text: preset.text }))).toEqual([
      { cmd: 'auto.end.1w', text: '一周' },
      { cmd: 'auto.end.2w', text: '两周' },
      { cmd: 'auto.end.1m', text: '一个月' },
      { cmd: 'auto.end.3m', text: '三个月' },
      { cmd: 'auto.end.eoy', text: '今年年底' },
      { cmd: 'auto.end.1y', text: '一年' },
    ]);

    const card = automationEndCard(TOKENS);
    expect(presetButtons(card)).toEqual([
      { cmd: 'auto.end.1w', text: '一周' },
      { cmd: 'auto.end.2w', text: '两周' },
      { cmd: 'auto.end.1m', text: '一个月' },
      { cmd: 'auto.end.3m', text: '三个月' },
      { cmd: 'auto.end.eoy', text: '今年年底' },
      { cmd: 'auto.end.1y', text: '一年' },
    ]);
  });

  it('sets 一周 to startAt plus seven local days and prints the exact remaining count', async () => {
    expect(presetEndAt('auto.end.1w', TZ, NOW, NOW)).toBe(WEEK_END);
    expect(presetEndAt('auto.end.2w', TZ, NOW, NOW)).toBe(TWO_WEEK_END);
    const nyStart = Date.UTC(2026, 2, 7, 15, 0, 0);
    expect(presetEndAt('auto.end.1w', 'America/New_York', nyStart, nyStart)).toBe(Date.UTC(2026, 2, 14, 14, 0, 0));

    const h = await harness();
    const parsed = parseScheduleText('每天 09:00', { taskType: 'reminder', now: NOW, timezone: TZ });
    if (parsed.ok || parsed.reason !== 'missing-end-at' || !parsed.pending) {
      throw new Error('expected a daily draft waiting for an end');
    }
    const draft = await h.store.saveDraft({
      taskType: 'reminder',
      schedule: parsed.pending,
      pendingRecurring: parsed.pending,
      timezone: TZ,
      startAt: NOW,
      nextFireAt: 0,
      chatId: CHAT,
      createdBy: USER,
      name: '站会',
      taskText: '提醒站会',
    });
    const endAt = resolveEndAt('auto.end.1w', { timezone: TZ, now: NOW, startAt: draft.startAt });
    expect(endAt).toBe(WEEK_END);
    expect(await completeDraftEnd({
      automations: h.store,
      autoAuth: h.autoAuth,
      channel: h.channel as never,
      now: () => NOW,
    }, draft, endAt!, 'om_end')).toEqual({ ok: true });
    expect(h.store.listDrafts()[0]).toMatchObject({ startAt: NOW, endAt: WEEK_END });

    const confirm = JSON.stringify(h.channel.sent.map((item) => item.content));
    expect(confirm).toContain('共 7 次');
    expect(confirm).toContain('2026-10-18 09:00');
    expect(confirm).toContain('2026-10-19 09:00');
    expect(confirm).toContain('2026-10-20 09:00');
    expect(confirm).not.toContain('约每月');
    expect(confirm).not.toContain('2026-10-17 09:00');
  });
});

function presetButtons(card: object): Array<{ cmd: string; text: string }> {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
  const formIndex = elements.findIndex((element) => isRecord(element) && element.tag === 'form');
  const rows = elements
    .slice(0, formIndex === -1 ? elements.length : formIndex)
    .filter((element) => isRecord(element) && element.tag === 'column_set');
  const buttons: Array<{ cmd: string; text: string }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const columns = Array.isArray(row.columns) ? row.columns : [];
    for (const column of columns) {
      if (!isRecord(column) || !Array.isArray(column.elements)) continue;
      for (const node of column.elements) {
        if (!isRecord(node) || node.tag !== 'button') continue;
        const text = isRecord(node.text) && typeof node.text.content === 'string' ? node.text.content : '';
        const behaviors = Array.isArray(node.behaviors) ? node.behaviors : [];
        const callback = behaviors.find((entry) => isRecord(entry) && entry.type === 'callback');
        const cmd = isRecord(callback) && isRecord(callback.value) && typeof callback.value.cmd === 'string'
          ? callback.value.cmd
          : '';
        buttons.push({ cmd, text });
      }
    }
  }
  return buttons;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-end-card-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: () => NOW,
  });
  await store.load();
  return {
    store,
    autoAuth: new AutoActionAuth({
      secret: 'auto-secret',
      nonceStore: new CallbackNonceStore(join(dir, 'nonces.json')),
      now: () => NOW,
    }),
    channel: createFakeChannel(),
  };
}
