import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutomationBoard } from '../../../src/automations/board';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { AutomationsStore } from '../../../src/automations/store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { CardSchemaError } from '../../helpers/card-schema2';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const CHAT = 'oc_group';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');
const dirs: string[] = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('board card create failures', () => {
  it('logs the Feishu code once and skips the same card until its content changes', async () => {
    const h = await harness();
    let creates = 0;
    const orig = h.channel.createCard.bind(h.channel);
    h.channel.createCard = async (card) => {
      creates += 1;
      return orig(card);
    };
    h.channel.cardErrors.create = new CardSchemaError();

    await h.board.refresh();
    await h.board.refresh();
    expect(creates).toBe(1);
    expect(h.store.getBoard(CHAT)).toBeUndefined();
    expect(await boardFailCodes(h.logsDir)).toEqual([200610]);

    await h.store.pause(h.itemId);
    h.channel.cardErrors.create = new CardSchemaError();
    await h.board.refresh();
    expect(creates).toBe(2);
    expect(await boardFailCodes(h.logsDir)).toEqual([200610, 200610]);
  });

  it('retries the next refresh when saving the board binding fails after create', async () => {
    const h = await harness();
    const orig = h.store.setBoard.bind(h.store);
    let failSave = true;
    h.store.setBoard = async (binding) => {
      if (failSave) {
        failSave = false;
        throw new Error('disk full');
      }
      return orig(binding);
    };

    await expect(h.board.refresh()).rejects.toThrow(/disk full/);
    expect(h.store.getBoard(CHAT)).toBeUndefined();
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBeTruthy();
  });

  it('retries a board create after a link error', async () => {
    const h = await harness();
    h.channel.cardErrors.create = axiosErrno('ECONNRESET', 'connect ECONNRESET');
    await expect(h.board.refresh()).rejects.toThrow(/ECONNRESET/);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBeTruthy();
  });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-board-fail-'));
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

async function boardFailCodes(logsDir: string): Promise<unknown[]> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as { phase?: string; _event?: string; code?: unknown })
    .filter((entry) => entry.phase === 'auto' && entry._event === 'board')
    .map((entry) => entry.code);
}
