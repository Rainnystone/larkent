import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutomationBoard } from '../../../src/automations/board';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { AutomationsStore } from '../../../src/automations/store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const CHAT = 'oc_group';
const NOW = Date.UTC(2026, 9, 18, 3, 0, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');
const dirs: string[] = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('board card.update', () => {
  it('does not bump sequence when cardkit update returns code != 0, logs code/msg, and resends+pins', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    expect(first?.cardId).toBeTruthy();
    expect(first?.sequence).toBeUndefined();
    const firstMessageId = first!.messageId;

    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 10004,
      msg: 'sequence invalid',
    });
    const origSetBoard = h.store.setBoard.bind(h.store);
    const sequencesOnFirst: Array<number | undefined> = [];
    h.store.setBoard = async (binding) => {
      if (binding.messageId === firstMessageId) sequencesOnFirst.push(binding.sequence);
      return origSetBoard(binding);
    };
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequencesOnFirst.filter((sequence) => sequence !== undefined)).toEqual([]);
    const next = h.store.getBoard(CHAT);
    expect(next?.sequence).toBeUndefined();
    expect(next?.messageId).not.toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next?.messageId]);
    expect(await boardFailEntries(h.logsDir)).toEqual([
      expect.objectContaining({ code: 10004, msg: 'sequence invalid' }),
    ]);
  });

  it('does not bump sequence when cardkit update omits code', async () => {
    const h = await harness();
    await h.board.refresh();
    const firstMessageId = h.store.getBoard(CHAT)!.messageId;
    h.channel.rawClient.cardkit.v1.card.update = async () => ({ msg: 'ok' });
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.store.getBoard(CHAT)?.messageId).not.toBe(firstMessageId);
  });

  it('keeps the old pin and store when replacement send fails after a patch error', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    expect(first?.messageId).toBeTruthy();
    const firstMessageId = first!.messageId;
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 300317,
      msg: 'card update failed',
    });
    h.channel.cardErrors.create = axiosErrno('ECONNRESET', 'connect ECONNRESET');
    await h.store.pause(h.itemId);
    await expect(h.board.refresh()).rejects.toThrow(/ECONNRESET/);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    await h.board.refresh();
    const next = h.store.getBoard(CHAT);
    expect(next?.messageId).toBeTruthy();
    expect(next?.messageId).not.toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next?.messageId]);
  });

  it('unpins the old board after a last-item resend, not only the replacement', async () => {
    const h = await harness();
    await h.board.refresh();
    const firstMessageId = h.store.getBoard(CHAT)!.messageId;
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    await h.store.delete(h.itemId);
    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 300317,
      msg: 'card update failed',
    });
    await h.board.refresh();

    expect(h.store.getBoard(CHAT)?.messageId).not.toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).not.toContain(firstMessageId);
  });

  it('bumps sequence after cardkit update returns code 0', async () => {
    const h = await harness();
    await h.board.refresh();
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBe(1);
    await h.store.resume(h.itemId, NOW + 2 * 60 * 60_000);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBe(2);
  });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-board-update-'));
  dirs.push(dir);
  const logsDir = join(dir, 'logs');
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: () => NOW,
  });
  const item = await store.create({
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW,
    endAt: NOW + 60 * 60_000,
    nextFireAt: NOW + 60 * 60_000,
    chatId: CHAT,
    createdBy: 'ou_user',
    name: '交周报',
    taskText: '提醒交周报',
  });
  await store.writeStatus('Pin Bot');
  const channel = createFakeChannel();
  const board = createAutomationBoard({
    store,
    channel: channel as never,
    auth: new BoardActionAuth({ secret: 'board-secret', now: () => NOW }),
    lockPath: join(dir, 'board.lock'),
  });
  return { logsDir, store, channel, board, itemId: item.id };
}

async function boardFailEntries(logsDir: string): Promise<Array<{ code?: unknown; msg?: unknown }>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as {
    phase?: string;
    _event?: string;
    code?: unknown;
    msg?: unknown;
  }).filter((entry) => entry.phase === 'auto' && entry._event === 'board');
}
