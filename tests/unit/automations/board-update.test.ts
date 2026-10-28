import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_PIN_FAILED_HINT, createAutomationBoard } from '../../../src/automations/board';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { AutomationsStore } from '../../../src/automations/store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno, axiosHttpError, axiosLike } from '../../helpers/sdk-feishu-errors';

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
    expect(pendingMessageIds(held)).toEqual([firstMessageId]);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);
    expect(h.store.findBoardByMessageId(firstMessageId)).toBeUndefined();

    const restarted = await reloadBoard(h);
    expect(pendingMessageIds(restarted.store.getBoard(CHAT))).toEqual([firstMessageId]);
    await restarted.board.refresh();
    const recovered = restarted.store.getBoard(CHAT);
    expect(recovered?.messageId).toBe(held?.messageId);
    expect(pendingMessageIds(recovered)).toEqual([]);
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
    expect(pendingMessageIds(replacement)).toEqual([firstMessageId]);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([firstMessageId]);

    await h.store.resume(h.itemId, NOW + 2 * 60 * 60_000);
    await h.board.refresh();
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(replacement?.messageId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([firstMessageId]);
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
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([firstMessageId]);

    failPinDeletes(h, 1);
    await h.board.refresh();
    const replacement = h.store.getBoard(CHAT);
    expect(replacement?.messageId).not.toBe(firstMessageId);
    expect(pendingMessageIds(replacement)).toEqual([firstMessageId]);
    expect(h.channel.pins.map((pin) => pin.messageId).sort()).toEqual(
      [firstMessageId, replacement!.messageId].sort(),
    );

    await h.board.refresh();
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([]);
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

    expect(sequences[0]).toBe(timeSequence(NOW));
    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
    const next = h.store.getBoard(CHAT);
    expect(next?.messageId).not.toBe(first.messageId);
    expect(next?.sequence).toBeUndefined();
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next?.messageId]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([
      expect.objectContaining({ reason }),
    ]);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({ code, msg, sequence: sequences[0] }),
      expect.objectContaining({ code, msg, sequence: sequences[1] }),
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

  it('keeps every still-pinned board across two 200750 resends when unpin keeps failing', async () => {
    const h = await harness();
    await h.board.refresh();
    const cardA = h.store.getBoard(CHAT)!;
    const expired = new Set<string>([cardA.cardId!]);
    scriptExpiredCards(h, expired);
    const unpin = failUnpinUntilReleased(h);

    await h.store.pause(h.itemId);
    await h.board.refresh();
    const cardB = h.store.getBoard(CHAT)!;
    expect(cardB.messageId).not.toBe(cardA.messageId);
    expectPinnedBoardsTracked(h);
    expired.add(cardB.cardId!);

    await h.board.refresh();
    const cardC = h.store.getBoard(CHAT)!;
    expect(cardC.messageId).not.toBe(cardB.messageId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([
      cardA.messageId,
      cardB.messageId,
    ]);
    expect(h.channel.pins.map((pin) => pin.messageId).sort()).toEqual(
      [cardA.messageId, cardB.messageId, cardC.messageId].sort(),
    );
    expectPinnedBoardsTracked(h);

    unpin.release();
    await h.board.refresh();
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([cardC.messageId]);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([]);
    expectPinnedBoardsTracked(h);
  });

  it('settles the replaced board once, with no buttons and a higher sequence', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const updates = scriptSettleUpdates(h, first.cardId!);
    const unpin = failUnpinUntilReleased(h);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const settle = updates.filter((update) => (
      update.cardId === first.cardId && update.cardText.includes('此看板已更新')
    ));
    expect(settle).toHaveLength(1);
    expect(settle[0]!.sequence).toBeGreaterThan(updates[0]!.sequence);
    expect(settle[0]!.cardText).toContain('此看板已更新，请查看置顶的新看板。');
    expect(settle[0]!.cardText).toContain('本群自动化');
    expect(settle[0]!.cardText).not.toContain('"tag":"button"');
    expect(settle[0]!.cardText).not.toContain('disabled');
    expect(settle[0]!.cardText).not.toContain('交周报');
    expect(settle[0]!.cardText).not.toContain('提醒交周报');
    expect(h.store.getBoard(CHAT)?.messageId).not.toBe(first.messageId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([first.messageId]);

    await h.board.refresh();
    expect(updates.filter((update) => (
      update.cardId === first.cardId && update.cardText.includes('此看板已更新')
    ))).toHaveLength(1);

    unpin.release();
    await h.board.refresh();
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([]);
    expect(updates.filter((update) => update.cardId === first.cardId)).toHaveLength(2);
  });

  it('retries a 200750 settle on the next refresh and stops after unpin succeeds', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const updates = scriptExpiredCards(h, new Set([first.cardId!]));
    const unpin = failUnpinUntilReleased(h);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const next = h.store.getBoard(CHAT)!;
    expect(next.messageId).not.toBe(first.messageId);
    expect(next.cardId).not.toBe(first.cardId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([first.messageId]);
    const settleAttempts = () => updates.filter((update) => update.cardId === first.cardId);
    expect(settleAttempts()).toHaveLength(2);
    expect(settleAttempts()[1]!.sequence).toBeGreaterThan(settleAttempts()[0]!.sequence);
    expect(await boardEvents(h.logsDir, 'board.patch-failed')).toEqual([
      expect.objectContaining({
        code: 200750,
        msg: 'card entity has expired',
        sequence: settleAttempts()[0]!.sequence,
      }),
      expect.objectContaining({
        code: 200750,
        msg: 'card entity has expired',
        sequence: settleAttempts()[1]!.sequence,
      }),
    ]);
    expect(JSON.stringify(await boardEvents(h.logsDir, 'board.patch-failed'))).not.toContain('提醒交周报');
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([
      expect.objectContaining({ reason: '200750' }),
    ]);

    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(next.messageId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([first.messageId]);
    expect(settleAttempts()).toHaveLength(3);
    expect(settleAttempts()[2]!.sequence).toBeGreaterThan(settleAttempts()[1]!.sequence);

    unpin.release();
    await h.board.refresh();
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next.messageId]);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([]);
    const afterUnpin = settleAttempts().length;
    await h.board.refresh();
    expect(settleAttempts()).toHaveLength(afterUnpin);
    expect(h.store.getBoard(CHAT)?.messageId).toBe(next.messageId);
  });

  it('warns when more than five boards are still waiting to be unpinned and does not drop any', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const seeded = ['om_pending_1', 'om_pending_2', 'om_pending_3', 'om_pending_4', 'om_pending_5'];
    await h.store.setBoard({
      ...first,
      pendingUnpinMessageIds: seeded,
    });
    scriptExpiredCards(h, new Set([first.cardId!]));
    failUnpinUntilReleased(h);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual([...seeded, first.messageId]);
    expect(await boardEvents(h.logsDir, 'board.pending-overflow')).toEqual([
      expect.objectContaining({ count: 6 }),
    ]);
    const overflow = JSON.stringify(await boardEvents(h.logsDir, 'board.pending-overflow'));
    expect(overflow).not.toContain(first.messageId);
    expect(overflow).not.toContain('om_pending_1');
  });

  it.each([
    {
      name: '230011',
      error: () => axiosLike('Request failed with status code 400', {
        response: { status: 400, data: { code: 230011, msg: 'The message was withdrawn.' } },
      }),
    },
    { name: '404 without code', error: () => axiosHttpError(404) },
  ])('resends once when pinning a patched board fails because the message is gone ($name)', async ({ error }) => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    withdrawBoardMessage(h, first.messageId, error);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const next = h.store.getBoard(CHAT)!;
    expect(next.messageId).not.toBe(first.messageId);
    expect(next.cardId).toBeTruthy();
    expect(next.cardId).not.toBe(first.cardId);
    expect(h.channel.sent.length).toBe(sent + 1);
    expect(JSON.stringify(h.channel.sent)).not.toContain(AUTO_PIN_FAILED_HINT);
    expect(h.channel.pins.map((pin) => pin.messageId)).toEqual([next.messageId]);
    expect(pendingMessageIds(next)).toEqual([]);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([
      expect.objectContaining({ _chatId: CHAT, reason: 'message-deleted' }),
    ]);

    await h.store.resume(h.itemId, NOW + 2 * 60 * 60_000);
    await h.board.refresh();
    expect(h.store.getBoard(CHAT)?.messageId).toBe(next.messageId);
    expect(h.channel.sent.length).toBe(sent + 1);
    expect(await boardEvents(h.logsDir, 'board.resend')).toHaveLength(1);
  });

  it.each([
    {
      name: 'rate limit 99991400',
      error: () => axiosLike('Request failed with status code 400', {
        response: { status: 400, data: { code: 99991400, msg: 'request trigger frequency limit' } },
      }),
    },
    { name: '403 without code', error: () => axiosHttpError(403) },
    { name: 'ECONNRESET', error: () => axiosErrno('ECONNRESET', 'connect ECONNRESET') },
  ])('does not resend when pinning fails with $name', async ({ error }) => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    withdrawBoardMessage(h, first.messageId, error);
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(h.channel.sent.length).toBe(sent + 1);
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain(AUTO_PIN_FAILED_HINT);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);
  });

  it('sends one replacement per refresh when the replacement pin also reports the message gone', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    const sent = h.channel.sent.length;
    h.channel.pins.splice(0);
    h.channel.rawClient.im.v1.pin.create = async () => {
      throw axiosLike('Request failed with status code 400', {
        response: { status: 400, data: { code: 230011, msg: 'The message was withdrawn.' } },
      });
    };
    await h.store.pause(h.itemId);
    await h.board.refresh();

    const next = h.store.getBoard(CHAT)!;
    expect(next.messageId).not.toBe(first.messageId);
    expect(pendingMessageIds(next)).toEqual([]);
    expect(h.channel.sent.length).toBe(sent + 2);
    expect(JSON.stringify(h.channel.sent.at(-1))).toContain(AUTO_PIN_FAILED_HINT);
    expect(await boardEvents(h.logsDir, 'board.resend')).toHaveLength(1);
    expect(await failEvents(h.logsDir, 'board.pin')).toHaveLength(1);
  });

  it('does not resend when listing pins fails with 404 without code', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    h.channel.rawClient.im.v1.pin.list = async () => {
      throw axiosHttpError(404);
    };
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(await boardEvents(h.logsDir, 'board.resend')).toEqual([]);
  });

  it('drops a pending unpin entry when unpin reports the message gone', async () => {
    const h = await harness();
    await h.board.refresh();
    const first = h.store.getBoard(CHAT)!;
    await h.store.setBoard({ ...first, pendingUnpinMessageIds: ['om_gone', 'om_busy'] });
    const pin = h.channel.rawClient.im.v1.pin;
    const orig = pin.delete.bind(pin);
    pin.delete = async (params) => {
      const messageId = (params as { path?: { message_id?: string } } | undefined)?.path?.message_id;
      if (messageId === 'om_gone') {
        throw axiosLike('Request failed with status code 400', {
          response: { status: 400, data: { code: 230011, msg: 'The message was withdrawn.' } },
        });
      }
      if (messageId === 'om_busy') throw new Error('unpin rate limited');
      return orig(params);
    };
    await h.store.pause(h.itemId);
    await h.board.refresh();

    expect(h.store.getBoard(CHAT)?.messageId).toBe(first.messageId);
    expect(pendingMessageIds(h.store.getBoard(CHAT))).toEqual(['om_busy']);
  });
});

async function failEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  return (await boardEvents(logsDir, 'fail')).filter((entry) => entry._event === event);
}

function withdrawBoardMessage(
  h: Awaited<ReturnType<typeof harness>>,
  messageId: string,
  error: () => unknown,
): void {
  const index = h.channel.pins.findIndex((pin) => pin.messageId === messageId);
  if (index >= 0) h.channel.pins.splice(index, 1);
  const pin = h.channel.rawClient.im.v1.pin;
  const orig = pin.create.bind(pin);
  pin.create = async (params) => {
    const data = (params as { data?: { message_id?: string } } | undefined)?.data;
    if (data?.message_id === messageId) throw error();
    return orig(params);
  };
}

function timeSequence(nowMs: number): number {
  return Math.floor((nowMs - Date.UTC(2026, 0, 1)) / 1000);
}

interface CardUpdateRecord {
  cardId: string;
  sequence: number;
  cardText: string;
}

function installCardUpdateScript(
  h: Awaited<ReturnType<typeof harness>>,
  decide: (update: CardUpdateRecord, seenForCard: number) => { code: number; msg: string } | 'ok',
): CardUpdateRecord[] {
  const updates: CardUpdateRecord[] = [];
  const orig = h.channel.rawClient.cardkit.v1.card.update.bind(h.channel.rawClient.cardkit.v1.card);
  const perCard = new Map<string, number>();
  h.channel.rawClient.cardkit.v1.card.update = async (params) => {
    const path = (params as { path?: { card_id?: string } } | undefined)?.path;
    const data = (params as { data?: { sequence?: number; card?: { data?: string } } } | undefined)?.data;
    const cardId = typeof path?.card_id === 'string' ? path.card_id : '';
    const sequence = typeof data?.sequence === 'number' ? data.sequence : -1;
    const cardText = typeof data?.card?.data === 'string' ? data.card.data : '';
    const record = { cardId, sequence, cardText };
    updates.push(record);
    const seen = (perCard.get(cardId) ?? 0) + 1;
    perCard.set(cardId, seen);
    const decision = decide(record, seen);
    if (decision !== 'ok') return decision;
    return orig(params);
  };
  return updates;
}

function scriptExpiredCards(
  h: Awaited<ReturnType<typeof harness>>,
  expired: Set<string>,
): CardUpdateRecord[] {
  return installCardUpdateScript(h, (update) => (
    expired.has(update.cardId)
      ? { code: 200750, msg: 'card entity has expired' }
      : 'ok'
  ));
}

function scriptSettleUpdates(
  h: Awaited<ReturnType<typeof harness>>,
  cardId: string,
): CardUpdateRecord[] {
  return installCardUpdateScript(h, (update, seen) => (
    update.cardId === cardId && seen === 1
      ? { code: 200750, msg: 'card entity has expired' }
      : 'ok'
  ));
}

function failUnpinUntilReleased(
  h: Awaited<ReturnType<typeof harness>>,
): { release(): void } {
  const pin = h.channel.rawClient.im.v1.pin;
  const orig = pin.delete.bind(pin);
  let fail = true;
  pin.delete = async (params) => {
    if (fail) throw new Error('unpin rate limited');
    return orig(params);
  };
  return {
    release() {
      fail = false;
    },
  };
}

function pendingMessageIds(board: object | undefined): string[] {
  const raw = (board as { pendingUnpinMessageIds?: unknown } | undefined)?.pendingUnpinMessageIds;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') return entry ? [entry] : [];
    if (!entry || typeof entry !== 'object' || !('messageId' in entry)) return [];
    const messageId = (entry as { messageId?: unknown }).messageId;
    return typeof messageId === 'string' && messageId ? [messageId] : [];
  });
}

function expectPinnedBoardsTracked(h: Awaited<ReturnType<typeof harness>>): void {
  const board = h.store.getBoard(CHAT);
  const known = new Set<string>([
    ...(board?.messageId ? [board.messageId] : []),
    ...pendingMessageIds(board),
  ]);
  for (const pin of h.channel.pins) {
    expect(known.has(pin.messageId)).toBe(true);
  }
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
