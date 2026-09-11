import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import {
  BACKFILL_LEDGER_MAX_IDS,
  BACKFILL_LOOKBACK_MS,
  BackfillLedger,
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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
