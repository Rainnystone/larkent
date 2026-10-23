import { describe, expect, it } from 'vitest';
import {
  identity, normalizePath, planShards, readWeights, replay, verifyCoverage,
  type ScheduleSpec,
} from '../../helpers/ci/test-plan';

const spec = (path: string, pool = 'forks', project = ''): ScheduleSpec => ({ path, pool, project });
const snapshot = (costs: Record<string, unknown>) => ({
  version: 1, metric: 'suite-duration-ms', vitestVersion: '2.1.9', sources: [], platforms: { linux: costs },
});

describe('duration-aware test planning', () => {
  it('assigns expensive work first to the lightest bin with deterministic ties', () => {
    const specs = ['d', 'b', 'a', 'c'].map(path => spec(`${path}.test.ts`));
    const weights = readWeights(snapshot({ 'a.test.ts': 10, 'b.test.ts': 8, 'c.test.ts': 4, 'd.test.ts': 2 }), 'linux', '2.1.9');
    const plan = planShards(specs, 2, weights);
    expect(plan.map(shard => shard.items.map(item => item.spec.path))).toEqual([
      ['a.test.ts', 'd.test.ts'], ['b.test.ts', 'c.test.ts'],
    ]);
    expect(plan.map(shard => shard.estimatedMs)).toEqual([12, 12]);
    expect(planShards([...specs].reverse(), 2, weights)).toEqual(plan);
    expect(verifyCoverage(specs, plan)).toEqual([]);
  });

  it('models Vitest pool partitioning rather than balancing pools together', () => {
    const specs = [spec('a', 'forks'), spec('b', 'forks'), spec('c', 'threads'), spec('d', 'threads')];
    const weights = readWeights(snapshot({ a: 100, b: 10, c: 90, d: 5 }), 'linux', '2.1.9');
    expect(planShards(specs, 2, weights).map(shard => shard.items.map(item => item.spec.path))).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('normalizes separators without merging case, projects, or pools', () => {
    expect(normalizePath('./tests\\unit\\a.test.ts')).toBe('tests/unit/a.test.ts');
    expect(identity(spec('A'))).not.toBe(identity(spec('a')));
    expect(identity(spec('a', 'forks', 'one'))).not.toBe(identity(spec('a', 'forks', 'two')));
    expect(identity(spec('a', 'forks'))).not.toBe(identity(spec('a', 'threads')));
    for (const path of ['../outside', '/absolute', 'C:\\absolute', '.']) expect(() => normalizePath(path)).toThrow();
  });

  it('always schedules new files and uses positive advisory fallback for malformed or stale data', () => {
    const specs = [spec('known'), spec('zero'), spec('negative'), spec('nan'), spec('new')];
    const weights = readWeights(snapshot({ known: 20, zero: 0, negative: -1, nan: Number.NaN }), 'linux', '2.1.9');
    expect(planShards(specs, 3, weights).flatMap(shard => shard.items).map(item => item.estimatedMs)).toEqual([20, 20, 20, 20, 20]);
    expect(weights.warnings.length).toBeGreaterThan(0);
    for (const data of [undefined, {}, { ...snapshot({ known: 1 }), version: 2 }, { ...snapshot({ known: 1 }), vitestVersion: '1.0' }]) {
      const fallback = readWeights(data, 'linux', '2.1.9');
      const plan = planShards(specs, 9, fallback);
      expect(verifyCoverage(specs, plan)).toEqual([]);
      expect(plan.flatMap(shard => shard.items).every(item => item.estimatedMs > 0)).toBe(true);
    }
  });

  it('rejects invalid shard counts and duplicate normalized identities without silently dropping tests', () => {
    const weights = readWeights(undefined, 'linux', '2.1.9');
    for (const count of [0, -1, 1.5, Number.NaN]) expect(() => planShards([spec('a')], count, weights)).toThrow();
    expect(() => planShards([spec('tests/a'), spec('tests\\a')], 2, weights)).toThrow(/duplicate/i);
    const plans = planShards([spec('a'), spec('b')], 2, weights);
    plans[1]!.items = [...plans[0]!.items];
    expect(verifyCoverage([spec('a'), spec('b')], plans).join(' ')).toMatch(/duplicate.*missing|missing.*duplicate/i);
  });

  it('replays FIFO worker lanes within independently running pools and states missing estimates', () => {
    const specs = ['a', 'b', 'c', 'd'].map(path => ({ ...spec(path), size: 1 }));
    const weights = readWeights(snapshot({ a: 10, b: 8, c: 4, d: 2 }), 'linux', '2.1.9');
    const result = replay(specs, 2, 1, weights);
    expect(result.weighted.shardsMs).toEqual([12, 12]);
    expect(result.weighted.wallMs).toBe(12);
    expect(result.missingEstimates).toEqual([]);
    expect(result.assumptions).toContain('suite-duration-only');
    expect(() => replay(specs, 2, 0, weights)).toThrow();
  });
});
