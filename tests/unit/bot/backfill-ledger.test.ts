import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import {
  BACKFILL_LEDGER_MAX_IDS,
  BACKFILL_LOOKBACK_MS,
  LIVE_WATERMARK_THROTTLE_MS,
  BackfillLedger,
  formatSelfHealLine,
} from '../../../src/bot/backfill-ledger';
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
  const dir = await mkdtemp(join(tmpdir(), 'backfill-ledger-'));
  dirs.push(dir);
  const file = join(dir, 'backfill-state.json');
  return { file, ledger: new BackfillLedger(file, { now }) };
}

describe('BackfillLedger', () => {
  it('treats a missing file as an empty ledger and does not create one until a record is accepted', async () => {
    const { file, ledger } = await fixture();
    await ledger.load();
    expect(ledger.claim('om_new')).toBe(true);
    expect(ledger.has('om_new')).toBe(false);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    ledger.release('om_new');
    await ledger.flush();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces bulk records into one snapshot write that flush still drains', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await ledger.load();
    for (let i = 0; i < 50; i++) {
      const id = `om_bulk_${String(i).padStart(2, '0')}`;
      expect(ledger.claim(id)).toBe(true);
      ledger.record(id, now - i);
    }
    await ledger.flush();
    expect(atomic.mock.calls).toHaveLength(1);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { processed: Record<string, number> };
    expect(Object.keys(saved.processed)).toHaveLength(50);
    expect(saved.processed.om_bulk_00).toBe(now);
    expect(saved.processed.om_bulk_49).toBe(now - 49);
  });

  it('records an accepted id atomically at mode 0o600 and reloads it as already processed', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await ledger.load();
    expect(ledger.claim('om_live')).toBe(true);
    ledger.record('om_live', now - 1_000);
    await ledger.flush();
    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      processed: { om_live: now - 1_000 },
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new BackfillLedger(file, { now: () => now });
    await reloaded.load();
    expect(reloaded.has('om_live')).toBe(true);
    expect(reloaded.claim('om_live')).toBe(false);
  });

  it('returns false from claim while an id is in-flight and after it is recorded', async () => {
    const { ledger } = await fixture();
    await ledger.load();
    expect(ledger.claim('om_race')).toBe(true);
    expect(ledger.claim('om_race')).toBe(false);
    ledger.record('om_race', 1_760_000_000_000);
    expect(ledger.claim('om_race')).toBe(false);
    expect(ledger.has('om_race')).toBe(true);
    await ledger.flush();
  });

  it('forgets a released claim so the same id can be evaluated again and never reaches the file', async () => {
    const { file, ledger } = await fixture();
    await ledger.load();
    expect(ledger.claim('om_gated')).toBe(true);
    ledger.release('om_gated');
    expect(ledger.has('om_gated')).toBe(false);
    expect(ledger.claim('om_gated')).toBe(true);
    ledger.release('om_gated');
    await ledger.flush();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves watermarks already in the document when recording a new id', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await writeFile(file, `${JSON.stringify({
      schemaVersion: 1,
      lastLiveAt: 1_759_000_000_000,
      lastBackfillEnd: 1_759_500_000_000,
      processed: { om_old: now - 60_000 },
    }, null, 2)}\n`);
    await ledger.load();
    expect(ledger.claim('om_next')).toBe(true);
    ledger.record('om_next', now - 1_000);
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastLiveAt: 1_759_000_000_000,
      lastBackfillEnd: 1_759_500_000_000,
      processed: { om_old: now - 60_000, om_next: now - 1_000 },
    });
  });

  it('honours an injected prune horizon shorter than the default lookback', async () => {
    const now = 1_760_000_000_000;
    const dir = await mkdtemp(join(tmpdir(), 'backfill-ledger-'));
    dirs.push(dir);
    const file = join(dir, 'backfill-state.json');
    const ledger = new BackfillLedger(file, { now: () => now, pruneHorizonMs: () => 60_000 });
    await writeFile(file, `${JSON.stringify({
      schemaVersion: 1,
      processed: { om_old: now - 60_001, om_fresh: now - 1_000 },
    })}\n`);
    await ledger.load();
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).processed).toEqual({ om_fresh: now - 1_000 });
  });

  it('drops ids older than twice the lookback window on load and after a later record', async () => {
    const now = 1_760_000_000_000;
    const stale = now - 2 * BACKFILL_LOOKBACK_MS - 1;
    const fresh = now - 60_000;
    const { file, ledger } = await fixture(() => now);
    await writeFile(file, `${JSON.stringify({
      schemaVersion: 1,
      processed: { om_stale: stale, om_fresh: fresh },
    })}\n`);
    await ledger.load();
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).processed).toEqual({ om_fresh: fresh });
    expect(ledger.has('om_stale')).toBe(false);

    expect(ledger.claim('om_newer')).toBe(true);
    ledger.record('om_newer', now);
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).processed).toEqual({
      om_fresh: fresh,
      om_newer: now,
    });
  });

  it('evicts the oldest ids when the hard cap is exceeded', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    const processed: Record<string, number> = {};
    for (let i = 0; i < BACKFILL_LEDGER_MAX_IDS; i++) {
      processed[`om_${String(i).padStart(4, '0')}`] = now - BACKFILL_LEDGER_MAX_IDS + i;
    }
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, processed })}\n`);
    await ledger.load();
    expect(ledger.claim('om_newest')).toBe(true);
    ledger.record('om_newest', now);
    await ledger.flush();
    const saved = JSON.parse(await readFile(file, 'utf8')).processed as Record<string, number>;
    expect(Object.keys(saved)).toHaveLength(BACKFILL_LEDGER_MAX_IDS);
    expect(saved.om_0000).toBeUndefined();
    expect(saved.om_newest).toBe(now);
    expect(saved.om_0001).toBe(now - BACKFILL_LEDGER_MAX_IDS + 1);
  });

  it.each([
    '{',
    'null',
    '[]',
    '{"schemaVersion":2,"processed":{}}',
    '{"schemaVersion":1,"processed":[]}',
    '{"processed":{"om_x":1}}',
  ])('warns, runs empty, and leaves a corrupt or future-schema file untouched: %s', async (text) => {
    const { file, ledger } = await fixture();
    await writeFile(file, text);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await ledger.load();
    expect(warn.mock.calls.map(([phase, event]) => `${phase}.${event}`)).toEqual([
      'backfill.ledger-load-failed',
    ]);
    expect(ledger.claim('om_after')).toBe(true);
    ledger.record('om_after', 1_760_000_000_000);
    await ledger.flush();
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(ledger.has('om_after')).toBe(true);
  });

  it('keeps accepting claims after a persist failure and surfaces that failure on flush', async () => {
    const { file, ledger } = await fixture();
    await ledger.load();
    const failure = { reason: 'disk failure' };
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>(
      '../../../src/platform/atomic-write',
    );
    atomic.mockImplementationOnce((path, data, opts) =>
      actual.writeFileAtomic(path, data, {
        ...opts,
        rename: async () => {
          throw failure;
        },
      }),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(ledger.claim('om_first')).toBe(true);
    ledger.record('om_first', 1_760_000_000_000);
    expect(ledger.claim('om_second')).toBe(true);
    ledger.record('om_second', 1_760_000_000_001);
    await expect(ledger.flush()).rejects.toBe(failure);
    expect(warn.mock.calls.map(([phase, event]) => `${phase}.${event}`)).toEqual([
      'backfill.ledger-persist-failed',
    ]);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ledger.has('om_first')).toBe(true);
    expect(ledger.has('om_second')).toBe(true);
    expect(ledger.claim('om_first')).toBe(false);
  });

  it('persists an incomplete scan origin and clears it on a later complete mark', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await ledger.load();
    ledger.touchLive(now - 60_000);
    ledger.markScanIncomplete(now - 60_000);
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastLiveAt: now - 60_000,
      incompleteFrom: now - 60_000,
      processed: {},
    });

    const reloaded = new BackfillLedger(file, { now: () => now });
    await reloaded.load();
    expect(reloaded.getIncompleteFrom()).toBe(now - 60_000);
    reloaded.markScanComplete(now, now);
    await reloaded.flush();
    expect(reloaded.getIncompleteFrom()).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastLiveAt: now,
      lastBackfillEnd: now,
      processed: {},
    });
  });

  it('touchLive writes lastLiveAt, exposes getters, and persists at most once per 30s', async () => {
    let now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await ledger.load();
    expect(ledger.getLiveAt()).toBeUndefined();
    expect(ledger.getLastBackfillEnd()).toBeUndefined();
    expect(ledger.getProcessedCount()).toBe(0);
    expect(ledger.getFilePath()).toBe(file);

    ledger.touchLive(now);
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(now);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastLiveAt: now,
      processed: {},
    });
    const writes = atomic.mock.calls.length;

    now += 15_000;
    ledger.touchLive(now);
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(now);
    expect(atomic.mock.calls.length).toBe(writes);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(now - 15_000);

    now += LIVE_WATERMARK_THROTTLE_MS - 15_000;
    ledger.touchLive(now);
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(now);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(now);
  });

  it('does not persist when touchLive is called with the same watermark', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await ledger.load();
    ledger.touchLive(now);
    await ledger.flush();
    const writes = atomic.mock.calls.length;
    ledger.touchLive(now);
    await ledger.flush();
    expect(atomic.mock.calls.length).toBe(writes);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(now);
  });

  it('rewrites a backwards clock to now and warns clock-skew once', async () => {
    const { file, ledger } = await fixture();
    await ledger.load();
    ledger.touchLive(1_760_000_030_000);
    await ledger.flush();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    ledger.touchLive(1_760_000_000_000);
    ledger.touchLive(1_759_999_000_000);
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(1_759_999_000_000);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(1_759_999_000_000);
    expect(warn.mock.calls.map(([phase, event]) => `${phase}.${event}`)).toEqual([
      'backfill.clock-skew',
    ]);
  });

  it('reloads watermarks and processed count for doctor', async () => {
    const now = 1_760_000_000_000;
    const { file, ledger } = await fixture(() => now);
    await writeFile(file, `${JSON.stringify({
      schemaVersion: 1,
      lastLiveAt: now - 45_000,
      lastBackfillEnd: now - 120_000,
      processed: { om_a: now - 1_000, om_b: now - 2_000 },
    }, null, 2)}\n`);
    await ledger.load();
    expect(ledger.getLiveAt()).toBe(now - 45_000);
    expect(ledger.getLastBackfillEnd()).toBe(now - 120_000);
    expect(ledger.getProcessedCount()).toBe(2);
  });
});

describe('formatSelfHealLine', () => {
  it('renders ledger path, watermark age, and processed count without naming an agent', () => {
    expect(formatSelfHealLine({
      path: '/tmp/profile/backfill-state.json',
      processedCount: 0,
      now: 1_760_000_000_000,
    })).toBe(
      'self-heal: ledger=/tmp/profile/backfill-state.json lastLiveAt=not yet recorded processed=0',
    );
    expect(formatSelfHealLine({
      path: '/tmp/profile/backfill-state.json',
      lastLiveAt: 1_760_000_000_000 - 45_000,
      processedCount: 3,
      now: 1_760_000_000_000,
    })).toBe(
      'self-heal: ledger=/tmp/profile/backfill-state.json lastLiveAt=45s ago processed=3',
    );
    expect(formatSelfHealLine({
      lastLiveAt: 1_760_000_000_000 - 3 * 60_000,
      processedCount: 1,
      now: 1_760_000_000_000,
    })).toBe('self-heal: ledger=unavailable lastLiveAt=3m ago processed=1');
    expect(formatSelfHealLine({
      path: '/tmp/profile/backfill-state.json',
      lastLiveAt: 1_760_000_000_000 - 2 * 3_600_000,
      processedCount: 0,
      now: 1_760_000_000_000,
    })).toContain('2h ago');
    expect(formatSelfHealLine({
      path: '/tmp/profile/backfill-state.json',
      lastLiveAt: 1_760_000_000_000,
      processedCount: 0,
      now: 1_760_000_000_000,
    })).not.toMatch(/claude|codex|kimi|grok|cursor|antigravity|bot/i);
  });
});
