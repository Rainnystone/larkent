import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import {
  TURN_JOURNAL_MAX_ENTRIES,
  TURN_JOURNAL_SCHEMA_VERSION,
  TurnJournal,
  type TurnJournalEntry,
} from '../../../src/bot/turn-journal';
import { log } from '../../../src/core/logger';

vi.mock('../../../src/platform/atomic-write', async (original) => {
  const actual = await original<typeof import('../../../src/platform/atomic-write')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});
const atomic = vi.mocked(writeFileAtomic);

const dirs: string[] = [];

afterEach(async () => {
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>(
    '../../../src/platform/atomic-write',
  );
  atomic.mockReset().mockImplementation(actual.writeFileAtomic);
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

async function fixture(now = () => 1_760_000_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-journal-'));
  dirs.push(dir);
  const file = join(dir, 'turn-journal.json');
  return { file, journal: new TurnJournal(file, { now }) };
}

function queued(overrides: Partial<TurnJournalEntry> = {}): Omit<TurnJournalEntry, 'updatedAt' | 'createdAt'> {
  return {
    turnId: 'turn-1',
    scope: 'oc_group',
    chatId: 'oc_group',
    messageIds: ['om_1'],
    senderId: 'ou_user',
    initiatorId: 'ou_user',
    status: 'queued',
    ...overrides,
  };
}

describe('TurnJournal', () => {
  it('treats a missing file as empty and does not create one until a turn is recorded', async () => {
    const { file, journal } = await fixture();
    await journal.load();
    expect(journal.list()).toEqual([]);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await journal.flush();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists a queued turn atomically at mode 0o600 and reloads it', async () => {
    const now = 1_760_000_000_000;
    const { file, journal } = await fixture(() => now);
    await journal.load();
    journal.enqueue(queued({
      resumeHandle: 'sess-start',
      policyFingerprint: 'fp-1',
    }));
    await journal.flush();
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      schemaVersion: number;
      entries: TurnJournalEntry[];
    };
    expect(raw.schemaVersion).toBe(TURN_JOURNAL_SCHEMA_VERSION);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]).toMatchObject({
      turnId: 'turn-1',
      scope: 'oc_group',
      status: 'queued',
      resumeHandle: 'sess-start',
      policyFingerprint: 'fp-1',
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new TurnJournal(file, { now: () => now });
    await reloaded.load();
    expect(reloaded.get('turn-1')?.status).toBe('queued');
  });

  it('persists message resources for resumeless continue replay', async () => {
    const { file, journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({
      resources: [{ type: 'image', fileKey: 'img_1', sourceMessageId: 'om_user' }],
    }));
    await journal.flush();
    const reloaded = new TurnJournal(file);
    await reloaded.load();
    expect(reloaded.get('turn-1')?.resources).toEqual([
      { type: 'image', fileKey: 'img_1', sourceMessageId: 'om_user' },
    ]);
  });

  it('walks queued → running → settled → reply-delivered', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-1',
      pid: 4242,
      startedAt: 1_760_000_000_100,
    });
    journal.markSettled('turn-1', { kind: 'completed', retriable: false, needsHuman: false });
    journal.markReplyDelivered('turn-1');
    await journal.flush();
    expect(journal.get('turn-1')).toMatchObject({
      status: 'reply-delivered',
      runId: 'run-1',
      childPid: 4242,
      childStartedAt: 1_760_000_000_100,
      outcome: { kind: 'completed' },
    });
  });

  it('keeps completed-undelivered until recover resends exactly once', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.markSettled('turn-1', { kind: 'completed', retriable: false, needsHuman: false });
    journal.markCompletedUndelivered('turn-1', {
      markdown: 'final answer',
      replyTo: 'om_1',
      replyMode: 'text',
    });
    await journal.flush();
    expect(journal.get('turn-1')?.status).toBe('completed-undelivered');

    const resend = vi.fn<(entry: TurnJournalEntry) => Promise<boolean>>(async () => true);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    await journal.recover({ enabled: true, resend });
    await journal.recover({ enabled: true, resend });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend.mock.calls[0]?.[0]).toMatchObject({
      turnId: 'turn-1',
      reply: { markdown: 'final answer', replyTo: 'om_1' },
    });
    expect(journal.get('turn-1')?.status).toBe('reply-delivered');
    const recovered = info.mock.calls.filter(([phase, event]) => phase === 'journal' && event === 'recovered');
    expect(recovered).toHaveLength(1);
  });

  it('resends a settled turn that already has a stored reply', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.markSettled('turn-1', { kind: 'completed', retriable: false, needsHuman: false });
    journal.update('turn-1', {
      reply: { markdown: 'final answer', replyTo: 'om_1', replyMode: 'text' },
    });
    const resend = vi.fn(async () => true);
    await journal.recover({ enabled: true, resend });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(journal.get('turn-1')?.status).toBe('reply-delivered');
  });

  it('does not resend or reap orphans when recovery is disabled', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'undelivered' }));
    journal.markCompletedUndelivered('undelivered', {
      markdown: 'hold',
      replyTo: 'om_1',
      replyMode: 'text',
    });
    journal.enqueue(queued({ turnId: 'orphan', messageIds: ['om_2'] }));
    journal.noteSpawn({ scope: 'oc_group', runId: 'run-orphan', pid: 99, startedAt: 1 });
    await journal.flush();
    const resend = vi.fn(async () => true);
    await journal.recover({ enabled: false, resend, kill, isAlive: () => true });
    expect(resend).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(journal.get('undelivered')?.status).toBe('completed-undelivered');
    expect(journal.get('orphan')?.status).toBe('running');
  });

  it('kills a still-living child whose pid and start time match, then marks interrupted', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-live',
      pid: 777,
      startedAt: 1_760_000_000_050,
    });
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    await journal.recover({
      enabled: true,
      kill,
      isAlive: (pid) => pid === 777,
      processStartMs: (pid) => (pid === 777 ? 1_760_000_000_050 : undefined),
      orphanGraceMs: 0,
    });
    expect(kill).toHaveBeenCalled();
    expect(journal.get('turn-1')?.status).toBe('interrupted');
    expect(journal.get('turn-1')?.outcome).toMatchObject({
      kind: 'interrupted',
      reason: { type: 'external-signal' },
    });
    expect(info.mock.calls.filter(([phase, event]) => phase === 'journal' && event === 'recovered')).toHaveLength(1);
  });

  it('does not kill a live pid when its start time cannot be read', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-unverified',
      pid: 777,
      startedAt: 1_760_000_000_050,
    });
    await journal.recover({
      enabled: true,
      kill,
      isAlive: () => true,
      processStartMs: () => undefined,
      orphanGraceMs: 0,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(journal.get('turn-1')?.status).toBe('interrupted');
  });

  it('does not synthesize a running entry when noteSpawn has no queued IM turn', async () => {
    const { journal } = await fixture();
    await journal.load();
    expect(journal.noteSpawn({
      scope: 'comment:doc',
      runId: 'run-comment',
      pid: 99,
      startedAt: 1,
    })).toBe('run-comment');
    expect(journal.list()).toEqual([]);
  });

  it('does not reap a still-running scope that this process still owns', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-live',
      pid: 777,
      startedAt: 1_760_000_000_050,
    });
    await journal.recover({
      enabled: true,
      kill,
      isAlive: () => true,
      processStartMs: () => 1_760_000_000_050,
      orphanGraceMs: 0,
      isActive: (scope) => scope === 'oc_group',
    });
    expect(kill).not.toHaveBeenCalled();
    expect(journal.get('turn-1')?.status).toBe('running');
  });

  it('sends SIGKILL to the process group even after the leader exits on SIGTERM', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-group',
      pid: 777,
      startedAt: 1_760_000_000_050,
    });
    await journal.recover({
      enabled: true,
      kill,
      isAlive: () => true,
      processStartMs: () => 1_760_000_000_050,
      orphanGraceMs: 0,
    });
    expect(kill.mock.calls.map((call) => call[1])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(journal.get('turn-1')?.status).toBe('interrupted');
  });

  it('does not kill a recycled pid whose start time does not match', async () => {
    const kill = vi.fn();
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-stale',
      pid: 777,
      startedAt: 1_760_000_000_050,
    });
    await journal.recover({
      enabled: true,
      kill,
      isAlive: () => true,
      processStartMs: () => 1_760_000_009_000,
      orphanGraceMs: 0,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(journal.get('turn-1')?.status).toBe('interrupted');
  });

  it('resends notice-pending entries on recover and rate-limits them', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'n1', messageIds: ['om_a'] }));
    journal.enqueue(queued({ turnId: 'n2', messageIds: ['om_b'] }));
    journal.markNoticePending('n1', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice-one',
    });
    journal.markNoticePending('n2', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice-two',
    });
    const sent: string[] = [];
    const sleeps: number[] = [];
    await journal.recover({
      enabled: true,
      resendNotice: async (entry) => {
        sent.push(entry.turnId);
        return true;
      },
      noticeGapMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sent).toEqual(['n1', 'n2']);
    expect(sleeps).toEqual([500]);
    expect(journal.get('n1')?.status).toBe('notice-delivered');
    expect(journal.get('n2')?.status).toBe('notice-delivered');
  });

  it('does not resend a notice-pending turn whose scope is still live', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'live-notice' }));
    journal.markNoticePending('live-notice', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice-live',
    });
    const resendNotice = vi.fn(async () => true);
    await journal.recover({
      enabled: true,
      resendNotice,
      isActive: (scope) => scope === 'oc_group',
    });
    expect(resendNotice).not.toHaveBeenCalled();
    expect(journal.get('live-notice')?.status).toBe('notice-pending');
  });

  it('resends a pending terminal reply together with a notice-pending turn', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'both' }));
    journal.update('both', {
      reply: { markdown: 'error card', replyTo: 'om_1', replyMode: 'card', deliveryId: 'reply:both' },
    });
    journal.markNoticePending('both', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice',
      deliveryId: 'notice-uuid',
    });
    const resend = vi.fn(async () => true);
    const resendNotice = vi.fn(async () => true);
    await journal.recover({ enabled: true, resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resendNotice).toHaveBeenCalledTimes(1);
    expect(journal.get('both')?.status).toBe('notice-delivered');
    await journal.recover({ enabled: true, resend, resendNotice });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resendNotice).toHaveBeenCalledTimes(1);
  });

  it('does not resend a notice that is already in-flight or already has a message id', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'inflight' }));
    journal.markNoticePending('inflight', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice',
    });
    const resendNotice = vi.fn(async () => true);
    const held = journal.withDelivery('notice:inflight', async () => {
      await journal.recover({ enabled: true, resendNotice });
      expect(resendNotice).not.toHaveBeenCalled();
    });
    await held;
    journal.noteDelivery('notice-uuid', 'om_landed');
    journal.update('inflight', {
      notice: {
        kind: 'continue',
        recipientChatId: 'oc_group',
        markdown: 'notice',
        deliveryId: 'notice-uuid',
        messageId: 'om_landed',
      },
    });
    await journal.recover({ enabled: true, resendNotice });
    expect(resendNotice).not.toHaveBeenCalled();
    expect(journal.get('inflight')?.status).toBe('notice-delivered');
  });

  it('does not mark a queued in-flight start interrupted before a pid is journaled', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'starting' }));
    await journal.recover({ enabled: true });
    expect(journal.get('starting')?.status).toBe('queued');
    expect(journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-starting',
      pid: 4242,
      startedAt: 1_760_000_000_050,
    })).toBe('starting');
    expect(journal.get('starting')).toMatchObject({
      status: 'running',
      childPid: 4242,
    });
  });

  it('marks a queued-without-pid entry interrupted after a process restart', async () => {
    const { file, journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'stale-queued' }));
    await journal.flush();

    const restarted = new TurnJournal(file, { now: () => 1_760_000_000_000 });
    await restarted.load();
    expect(restarted.get('stale-queued')?.status).toBe('queued');
    await restarted.recover({ enabled: true });
    expect(restarted.get('stale-queued')?.status).toBe('interrupted');
  });

  it('notifies once and logs recovered when restarting over a running turn', async () => {
    const { file, journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'crash-run' }));
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-crash',
      pid: 4242,
      startedAt: 1_760_000_000_050,
    });
    await journal.flush();

    const onInterrupted = vi.fn(async (_entry: TurnJournalEntry) => true);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const restarted = new TurnJournal(file, { now: () => 1_760_000_000_000 });
    await restarted.load();
    await restarted.recover({
      enabled: true,
      onInterrupted,
      isAlive: () => false,
    });
    await restarted.recover({
      enabled: true,
      onInterrupted,
      isAlive: () => false,
    });
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(onInterrupted.mock.calls[0]?.[0]).toMatchObject({
      turnId: 'crash-run',
      status: 'interrupted',
      outcome: { kind: 'interrupted', reason: { type: 'external-signal' } },
    });
    expect(restarted.get('crash-run')?.status).toBe('interrupted');
    const recovered = info.mock.calls.filter(([phase, event]) => (
      phase === 'journal' && event === 'recovered'
    ));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.[2]).toMatchObject({ interrupted: 1, notices: 1, orphans: 0 });
  });

  it('invalidates delivered notice actions on session switch without un-delivering them', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'done-notice' }));
    journal.markNoticePending('done-notice', {
      kind: 'continue',
      recipientChatId: 'oc_group',
      markdown: 'notice',
    });
    journal.markNoticeDelivered('done-notice');
    journal.voidScope('oc_group');
    expect(journal.get('done-notice')?.status).toBe('notice-delivered');
    expect(journal.get('done-notice')?.noticeInvalidated).toBe(true);
  });

  it('voids incomplete records for a scope on session switch', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued({ turnId: 'old', scope: 'oc_group' }));
    journal.enqueue(queued({ turnId: 'other', scope: 'oc_other', chatId: 'oc_other', messageIds: ['om_x'] }));
    journal.voidScope('oc_group');
    await journal.flush();
    expect(journal.get('old')?.status).toBe('voided');
    expect(journal.get('other')?.status).toBe('queued');
  });

  it('does not let a later settle or reply overwrite a voided turn', async () => {
    const { journal } = await fixture();
    await journal.load();
    journal.enqueue(queued());
    journal.noteSpawn({
      scope: 'oc_group',
      runId: 'run-1',
      pid: 7,
      startedAt: 1,
    });
    journal.voidScope('oc_group');
    journal.markSettled('turn-1', { kind: 'interrupted', reason: { type: 'superseded', by: 'new' }, retriable: false, needsHuman: false });
    journal.markReplyDelivered('turn-1');
    journal.markCompletedUndelivered('turn-1', {
      markdown: 'late',
      replyTo: 'om_1',
      replyMode: 'text',
    });
    await journal.flush();
    expect(journal.get('turn-1')?.status).toBe('voided');
    expect(journal.get('turn-1')?.reply).toBeUndefined();
  });

  it.each([
    '{',
    'null',
    '[]',
    '{"schemaVersion":2,"entries":[]}',
    '{"schemaVersion":1,"entries":{}}',
    '{"entries":[]}',
  ])('warns, runs empty, and leaves a corrupt or future-schema file untouched: %s', async (text) => {
    const { file, journal } = await fixture();
    await writeFile(file, text);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await journal.load();
    expect(warn.mock.calls.map(([phase, event]) => `${phase}.${event}`)).toEqual([
      'journal.load-failed',
    ]);
    journal.enqueue(queued());
    await journal.flush();
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(journal.get('turn-1')?.status).toBe('queued');
  });

  it('evicts the oldest delivered records when the hard cap is exceeded', async () => {
    const now = 1_760_000_000_000;
    const { file, journal } = await fixture(() => now);
    const entries = Array.from({ length: TURN_JOURNAL_MAX_ENTRIES }, (_, i) => ({
      turnId: `turn_${String(i).padStart(4, '0')}`,
      scope: 'oc_group',
      chatId: 'oc_group',
      messageIds: [`om_${i}`],
      senderId: 'ou_user',
      initiatorId: 'ou_user',
      status: 'reply-delivered' as const,
      createdAt: now - TURN_JOURNAL_MAX_ENTRIES + i,
      updatedAt: now - TURN_JOURNAL_MAX_ENTRIES + i,
    }));
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, entries })}\n`);
    await journal.load();
    journal.enqueue(queued({ turnId: 'turn_new', messageIds: ['om_new'] }));
    await journal.flush();
    const saved = JSON.parse(await readFile(file, 'utf8')) as { entries: Array<{ turnId: string }> };
    expect(saved.entries).toHaveLength(TURN_JOURNAL_MAX_ENTRIES);
    expect(saved.entries.some((entry) => entry.turnId === 'turn_0000')).toBe(false);
    expect(saved.entries.some((entry) => entry.turnId === 'turn_new')).toBe(true);
  });

  it('does not prune incomplete records to make room for a new turn', async () => {
    const now = 1_760_000_000_000;
    const { journal } = await fixture(() => now);
    await journal.load();
    for (let i = 0; i < 3; i++) {
      journal.enqueue(queued({ turnId: `open_${i}`, messageIds: [`om_${i}`] }));
    }
    await journal.flush();
    const tight = new TurnJournal(journal.getFilePath(), {
      now: () => now,
      maxEntries: 3,
    });
    await tight.load();
    tight.enqueue(queued({ turnId: 'open_3', messageIds: ['om_3'] }));
    await tight.flush();
    expect(tight.list().map((entry) => entry.turnId).sort()).toEqual([
      'open_0', 'open_1', 'open_2', 'open_3',
    ]);
  });
});
