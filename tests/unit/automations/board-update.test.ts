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
  it('does not persist sequence when cardkit update returns an unlisted code, and does not resend', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    expect(first?.cardId).toBeTruthy();
    expect(first?.sequence).toBeUndefined();
    const firstMessageId = first!.messageId;
    const pins = h.channel.pins.map((pin) => pin.messageId);
    const sent = h.channel.sent.length;

    const sequences = scriptCardUpdates(h, [{ code: 10004, msg: 'sequence invalid' }]);
    const origSetBoard = h.store.setBoard.bind(h.store);
    const sequencesOnFirst: Array<number | undefined> = [];
    h.store.setBoard = async (binding) => {
      if (binding.messageId === firstMessageId) sequencesOnFirst.push(binding.sequence);
      return origSetBoard(binding);
    };
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toEqual([timeSequence(NOW)]);
    expect(sequencesOnFirst.filter((sequence) => sequence !== undefined)).toEqual([]);
    const next = h.store.getBoard(CHAT);
    expect(next?.sequence).toBeUndefined();
    expect(next?.messageId).toBe(firstMessageId);
    expect(h.channel.sent.length).toBe(sent);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual(pins);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({ code: 10004, msg: 'sequence invalid', sequence: timeSequence(NOW) }),
    ]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);
  });

  it('does not persist sequence or resend when cardkit update omits code', async () => {
    const h = await harness();
    await h.board.refresh();
    const firstMessageId = h.store.getBoard(CHAT)!.messageId;
    const sent = h.channel.sent.length;
    h.channel.rawClient.cardkit.v1.card.update = async () => ({ msg: 'ok' });
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(firstMessageId);
    expect(h.channel.sent.length).toBe(sent);
  });

  it('keeps the old pin and store when replacement send fails after a patch error', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    expect(first?.messageId).toBeTruthy();
    const firstMessageId = first!.messageId;
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    h.channel.rawClient.cardkit.v1.card.update = async () => ({
      code: 200740,
      msg: 'card entity does not exist',
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
      code: 200750,
      msg: 'card entity has expired',
    });
    await h.board.refresh();

    expect(h.store.getBoard(CHAT)?.messageId).not.toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).not.toContain(firstMessageId);
  });

  it('keeps the old pin after a transient pin failure and unpins it after a restart', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    expect(first?.messageId).toBeTruthy();
    const firstMessageId = first!.messageId;
    const firstCardId = first!.cardId;
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    rejectCardUpdateFor(h, firstCardId);
    failPinCreates(h, 1);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const held = h.store.getBoard(CHAT);
    expect(held?.messageId).not.toBe(firstMessageId);
    expect(held?.pendingUnpinMessageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);
    expect(h.store.findBoardByMessageId(firstMessageId)?.chatId).toBe(CHAT);

    const restarted = await reloadBoard(h);
    expect(restarted.store.getBoard(CHAT)?.pendingUnpinMessageId).toBe(firstMessageId);
    await restarted.board.refresh();
    const recovered = restarted.store.getBoard(CHAT);
    expect(recovered?.messageId).toBe(held?.messageId);
    expect(recovered?.pendingUnpinMessageId).toBeUndefined();
    expect(restarted.channel.pins.map((pin) => pin.messageId)).toEqual([recovered?.messageId]);
  });

  it('keeps the old pin and pending unpin id across persistent pin failures without resending', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT);
    const firstMessageId = first!.messageId;
    rejectCardUpdateFor(h, first?.cardId);
    failPinCreates(h, 'always');
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const replacement = h.store.getBoard(CHAT);
    expect(replacement?.messageId).not.toBe(firstMessageId);
    expect(replacement?.pendingUnpinMessageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    await h.store.resume(h.itemId, NOW + 2 * 60 * 60_000);
    await h.board.refresh();
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(replacement?.messageId);
    expect(h.store.getBoard(CHAT)?.pendingUnpinMessageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);
  });

  it('keeps the pending unpin id when unpin fails after the replacement is pinned', async () => {
    const h = await harness();
    await h.board.refresh();
    const firstMessageId = h.store.getBoard(CHAT)!.messageId;
    rejectCardUpdateFor(h, h.store.getBoard(CHAT)?.cardId);
    failPinCreates(h, 1);
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.pendingUnpinMessageId).toBe(firstMessageId);

    failPinDeletes(h, 1);
    await h.board.refresh();
    const replacement = h.store.getBoard(CHAT);
    expect(replacement?.messageId).not.toBe(firstMessageId);
    expect(replacement?.pendingUnpinMessageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId).sort()).toEqual(
      [firstMessageId, replacement!.messageId].sort(),
    );

    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.pendingUnpinMessageId).toBeUndefined();
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([replacement?.messageId]);
  });

  it('persists the monotonic sequence only after cardkit update returns code 0', async () => {
    const h = await harness();
    await h.board.refresh();
    const cardId = h.store.getBoard(CHAT)!.cardId!;
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBe(timeSequence(NOW));
    const patched = await boardEvents(h.logsDir, 'board.patch');
    expect(patched).toEqual([
      expect.objectContaining({
        cardId: cardId.slice(-4),
        sequence: timeSequence(NOW),
        retry: false,
      }),
    ]);
    expect(JSON.stringify(patched)).not.toContain(cardId);
    await h.store.resume(h.itemId, NOW + 2 * 60 * 60_000);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.sequence).toBe(timeSequence(NOW) + 1);
  });

  it('keeps the current pin when a last-item update is not resend-worthy', async () => {
    const h = await harness();
    await h.board.refresh();
    const firstMessageId = h.store.getBoard(CHAT)!.messageId;
    scriptCardUpdates(h, [{ code: 10004, msg: 'sequence invalid' }]);
    await h.store.delete(h.itemId);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(firstMessageId);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);
  });

  it('retries 300317 once with a larger sequence and does not send a new card', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const pins = h.channel.pins.map((pin) => pin.messageId);
    const sent = h.channel.sent.length;
    const sequences = scriptCardUpdates(h, [
      { code: 300317, msg: 'sequence number compare failed' },
      { code: 0, msg: 'ok' },
    ]);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
    expect(h.store.getBoard(CHAT)?.sequence).toBe(sequences[1]);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.store.getBoard(CHAT)?.cardId).toBe(first.cardId);
    expect(h.channel.sent.length).toBe(sent);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual(pins);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({ code: 300317, msg: 'sequence number compare failed', sequence: sequences[0] }),
    ]);
    expect(await boardEvents(h.logsDir, 'board.patch')).toEqual([
      expect.objectContaining({
        cardId: first.cardId!.slice(-4),
        retry: true,
        sequence: sequences[1],
      }),
    ]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);
  });

  it('does not resend when the 300317 retry itself fails, and resends on a later lost-card code', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    const sequences = scriptCardUpdates(h, [
      { code: 300317, msg: 'sequence number compare failed' },
      { code: 200740, msg: 'card entity does not exist' },
    ]);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.channel.sent.length).toBe(sent);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);

    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).not.toBe(first.messageId);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([
      expect.objectContaining({ reason: '200740' }),
    ]);
  });

  it('keeps the binding when 300317 fails twice and uses a larger sequence on the next refresh', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    const sequences = scriptCardUpdates(h, [
      { code: 300317, msg: 'sequence number compare failed' },
    ]);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toHaveLength(2);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.store.getBoard(CHAT)?.cardId).toBe(first.cardId);
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.channel.sent.length).toBe(sent);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([first.messageId]);

    await h.board.refresh();
    expect(sequences[2]).toBeGreaterThan(sequences[1]!);
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.channel.sent.length).toBe(sent);
  });

  it.each([
    { code: 200740, msg: 'card entity does not exist', reason: '200740' },
    { code: 200750, msg: 'card entity has expired', reason: '200750' },
    { code: 230110, msg: 'message has been deleted', reason: 'message-deleted' },
  ])('resends when card update returns $code', async ({ code, msg, reason }) => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sequences = scriptCardUpdates(h, [{ code, msg }]);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toEqual([timeSequence(NOW)]);
    const next = h.store.getBoard(CHAT);
    expect(next?.messageId).not.toBe(first.messageId);
    expect(next?.sequence).toBeUndefined();
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next?.messageId]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([
      expect.objectContaining({ reason }),
    ]);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({ code, msg, sequence: timeSequence(NOW) }),
    ]);
  });

  it('does not resend when card update returns 300311', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    const sequences = scriptCardUpdates(h, [{
      code: 300311,
      msg: 'The current application does not have permission to update/use this card',
    }]);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(sequences).toEqual([timeSequence(NOW)]);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.store.getBoard(CHAT)?.cardId).toBe(first.cardId);
    expect(h.store.getBoard(CHAT)?.sequence).toBeUndefined();
    expect(h.channel.sent.length).toBe(sent);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([first.messageId]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({ code: 300311, sequence: timeSequence(NOW) }),
    ]);
  });

  it('uses the time floor when it is ahead of the stored sequence, and stored+1 when stored is ahead', async () => {
    const epoch = Date.UTC(2026, 0, 1);
    const nowMs = epoch + 2_500_000 * 1000;
    const h = await harness({ now: () => nowMs });
    await h.board.refresh();
    const binding = h.store.getBoard(CHAT)!;
    await h.store.setBoard({ ...binding, sequence: 5 });
    const behind = scriptCardUpdates(h, [{ code: 0, msg: 'ok' }]);
    await h.store.pause(h.itemId);
    await h.board.refresh();
    expect(behind).toEqual([2_500_000]);
    expect(h.store.getBoard(CHAT)?.sequence).toBe(2_500_000);

    await h.store.setBoard({ ...h.store.getBoard(CHAT)!, sequence: 3_000_000 });
    const ahead = scriptCardUpdates(h, [{ code: 0, msg: 'ok' }]);
    await h.store.resume(h.itemId, nowMs + 2 * 60 * 60_000);
    await h.board.refresh();
    expect(ahead).toEqual([3_000_001]);
    expect(h.store.getBoard(CHAT)?.sequence).toBe(3_000_001);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(binding.messageId);
  });
});

function timeSequence(nowMs: number): number {
  return Math.floor((nowMs - Date.UTC(2026, 0, 1)) / 1000);
}

function scriptCardUpdates(
  h: Awaited<ReturnType<typeof harness>>,
  responses: Array<{ code: number; msg: string }>,
): number[] {
  const sequences: number[] = [];
  let index = 0;
  h.channel.rawClient.cardkit.v1.card.update = async (params) => {
    const data = (params as { data?: { sequence?: number } } | undefined)?.data;
    sequences.push(typeof data?.sequence === 'number' ? data.sequence : -1);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return { code: next.code, msg: next.msg };
  };
  return sequences;
}

async function harness(opts?: { now?: () => number }) {
  const now = opts?.now ?? (() => NOW);
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
    auth: new BoardActionAuth({ secret: 'board-secret', now }),
    lockPath: join(dir, 'board.lock'),
    now,
  });
  return { logsDir, store, channel, board, itemId: item.id, dir };
}

async function reloadBoard(h: Awaited<ReturnType<typeof harness>>) {
  const store = new AutomationsStore({
    path: join(h.dir, 'automations.json'),
    logPath: join(h.dir, 'automations.log'),
    statusPath: join(h.dir, 'automations-status.json'),
    now: () => NOW,
  });
  await store.load();
  const board = createAutomationBoard({
    store,
    channel: h.channel as never,
    auth: new BoardActionAuth({ secret: 'board-secret', now: () => NOW }),
    lockPath: join(h.dir, 'board.lock'),
  });
  return { store, board, channel: h.channel };
}

function rejectCardUpdateFor(
  h: Awaited<ReturnType<typeof harness>>,
  cardId: string | undefined,
): void {
  h.channel.rawClient.cardkit.v1.card.update = async (params) => {
    const path = (params as { path?: { card_id?: string } } | undefined)?.path;
    if (cardId && path?.card_id === cardId) {
      return { code: 200740, msg: 'card entity does not exist' };
    }
    return { code: 0, msg: 'ok' };
  };
}

function failPinCreates(
  h: Awaited<ReturnType<typeof harness>>,
  times: number | 'always',
): void {
  failPinOp(h.channel.rawClient.im.v1.pin, 'create', times, 'pin rate limited');
}

function failPinDeletes(
  h: Awaited<ReturnType<typeof harness>>,
  times: number | 'always',
): void {
  failPinOp(h.channel.rawClient.im.v1.pin, 'delete', times, 'unpin rate limited');
}

function failPinOp(
  pin: Awaited<ReturnType<typeof harness>>['channel']['rawClient']['im']['v1']['pin'],
  op: 'create' | 'delete',
  times: number | 'always',
  message: string,
): void {
  const orig = pin[op].bind(pin);
  let remaining = times;
  pin[op] = async (params) => {
    if (remaining === 'always' || remaining > 0) {
      if (remaining !== 'always') remaining -= 1;
      throw new Error(message);
    }
    return orig(params);
  };
}

async function boardEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.phase === 'auto' && entry.event === event);
}
