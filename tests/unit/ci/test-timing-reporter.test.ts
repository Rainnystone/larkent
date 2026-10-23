import { describe, expect, it, vi, type File } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vitest } from 'vitest/node';
import TimingReporter, { reconcileResults, updateTimings, resultFromFile, type TimingReport, type TimingResult } from '../../helpers/ci/test-timing-reporter';
import { identity, type ScheduleSpec, type TimingSnapshot } from '../../helpers/ci/test-plan';

import { digest, runtimeState } from '../../helpers/ci/test-runtime';

const spec = (path: string): ScheduleSpec => ({ path, project: '', pool: 'threads' });
const passed = (path: string, duration = 10) => ({ ...spec(path), outcome: 'pass' as const, suiteMs: duration, collectMs: 2, setupMs: 1, tests: { passed: 1, failed: 0, skipped: 0, todo: 0, incomplete: 0 } });
const seed: TimingSnapshot = { version: 1, metric: 'suite-duration-ms', vitestVersion: '2.1.9', sources: [], platforms: { linux: { a: 50, b: 60 } } };
function report(index: number, results: TimingResult[] = [passed(index === 1 ? 'a' : 'b')]): TimingReport {
  return {
    version: 1, metric: 'suite-duration-ms', vitestVersion: '2.1.9',
    source: { headSha: 'a'.repeat(40), runId: '123', runAttempt: '1' },
    environment: { platform: 'linux', arch: 'x64', node: 'v20.19.0', cpus: 4, workers: { threads: { min: 3, max: 3, isolated: true } }, fileParallelism: true },
    shard: { index, count: 2 }, discoveryHash: digest(JSON.stringify([spec('a'), spec('b')].map(identity).sort())), snapshotHash: 'snapshot', configurationHash: 'configuration', sampleEligible: true,
    selected: [spec(index === 1 ? 'a' : 'b')], discoveredCount: 2,
    results, complete: true, successful: true, diagnostics: [], elapsedMs: 123,
  };
}

describe('timing evidence', () => {
  it('reconciles exact identities and intentionally skipped files without treating them as timing zeroes', () => {
    const skip = { ...passed('b', 0), outcome: 'skip' as const, tests: { passed: 0, failed: 0, skipped: 1, todo: 0, incomplete: 0 } };
    expect(reconcileResults([spec('a'), spec('b')], [passed('a'), skip], 0)).toEqual({ complete: true, successful: true, diagnostics: [] });
    expect(updateTimings(seed, [report(1), report(2, [skip])]).platforms.linux).toEqual({ a: 10, b: 60 });
  });

  it('makes missing, duplicate, unexpected and incomplete outcomes explicit', () => {
    for (const results of [[], [passed('a'), passed('a')], [passed('other')], [{ ...passed('a'), outcome: 'incomplete' as const }], [{ ...passed('a'), tests: { ...passed('a').tests, incomplete: 1 } }]]) {
      const result = reconcileResults([spec('a')], results, 0);
      expect(result.complete).toBe(false);
      expect(result.successful).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    expect(reconcileResults([spec('a')], [{ ...passed('a'), outcome: 'fail' }], 0)).toMatchObject({ complete: true, successful: false });
    expect(reconcileResults([spec('a')], [passed('a')], 1)).toMatchObject({ complete: false, successful: false });
  });

  it('only learns complete, successful matching shard cohorts and never trusts a report success flag', () => {
    expect(() => updateTimings(seed, [report(1)])).toThrow(/cohort/i);
    expect(() => updateTimings(seed, [report(1), report(1)])).toThrow(/duplicate/i);
    const mixed = report(2); mixed.source.headSha = 'b'.repeat(40);
    expect(() => updateTimings(seed, [report(1), mixed])).toThrow(/cohort/i);
    const missing = report(2); missing.results = [];
    expect(() => updateTimings(seed, [report(1), missing])).toThrow(/incomplete/i);
    const failed = report(2); failed.results[0]!.outcome = 'fail';
    expect(() => updateTimings(seed, [report(1), failed])).toThrow(/successful/i);
    const invalid = report(2); invalid.results[0]!.suiteMs = Number.NaN;
    expect(updateTimings(seed, [report(1), invalid]).platforms.linux!.b).toBe(60);
  });

  it('rejects otherwise complete cohorts with incompatible same-platform execution settings', () => {
    for (const change of ['arch', 'node', 'workers', 'configuration'] as const) {
      const later = [report(1), report(2)];
      for (const item of later) {
        item.source.runId = '124';
        if (change === 'arch') item.environment.arch = 'arm64';
        if (change === 'node') item.environment.node = 'v22.0.0';
        if (change === 'workers') item.environment.workers.threads!.max = 1;
        if (change === 'configuration') item.configurationHash = 'changed';
      }
      expect(() => updateTimings(seed, [report(1), report(2), ...later])).toThrow(/incompatible/i);
    }
  });

  it('rejects filtered samples even when the test execution itself is successful', () => {
    const filtered = report(1); filtered.sampleEligible = false;
    expect(() => updateTimings(seed, [filtered, report(2)])).toThrow(/ineligible/i);
  });

  it('takes medians over compatible cohorts while preserving untouched platforms and skipped history', () => {
    const laterA = report(1, [passed('a', 30)]); laterA.source.runId = '124';
    const laterB = report(2, [passed('b', 40)]); laterB.source.runId = '124';
    const next = updateTimings({ ...seed, platforms: { ...seed.platforms, darwin: { a: 99 } } }, [report(1), report(2), laterA, laterB]);
    expect(next.platforms).toEqual({ linux: { a: 20, b: 25 }, darwin: { a: 99 } });
    expect(seed.platforms.linux).toEqual({ a: 50, b: 60 });
  });
});


describe('reporter integration seam', () => {
  it('resolves the pinned vmForks result alias only against an unambiguous selected manifest', () => {
    const file = { filepath: '/repo/a', pool: 'forks', tasks: [], mode: 'skip' } as unknown as File;
    expect(resultFromFile(file, '/repo', [{ ...spec('a'), pool: 'vmForks' }]).pool).toBe('vmForks');
    expect(resultFromFile(file, '/repo', [{ ...spec('a'), pool: 'forks' }, { ...spec('a'), pool: 'vmForks' }]).pool).toBe('forks');
    expect(resultFromFile(file, '/repo', [{ ...spec('a'), pool: 'vmThreads' }]).pool).toBe('forks');
  });

  it('records hook-inclusive runner suite timing, separate loading costs, skips and effective settings without private output', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-reporter-'));
    const previousOutput = process.env.LARK_CI_TIMING_REPORT;
    const previousExit = process.exitCode;
    process.env.LARK_CI_TIMING_REPORT = 'report.json';
    try {
      const ctx = { config: { root, setupFiles: [], sequence: {}, fileParallelism: true, isolate: true, maxWorkers: 2, minWorkers: 1 }, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Vitest;
      const reporter = new TimingReporter();
      reporter.onInit(ctx);
      reporter.onSpecsCollected([[{ name: '', root }, join(root, 'hooks.test.ts'), { pool: 'forks' }]]);
      const state = runtimeState(ctx);
      state.selected.push({ path: 'hooks.test.ts', project: '', pool: 'forks' });
      state.selectionCalls++;
      const file = {
        filepath: join(root, 'hooks.test.ts'), projectName: '', pool: 'forks', mode: 'run',
        result: { state: 'pass', duration: 1000 }, collectDuration: 40, setupDuration: 20,
        tasks: [{ type: 'test', mode: 'run', result: { state: 'pass', duration: 1 } }, { type: 'test', mode: 'skip' }],
        logs: ['private test stdout'],
      } as unknown as File;
      reporter.onFinished([file]);
      const raw = readFileSync(join(root, 'report.json'), 'utf8');
      const saved = JSON.parse(raw) as TimingReport;
      expect(saved).toMatchObject({ complete: true, successful: true, environment: { workers: { forks: { min: 1, max: 2 } } } });
      expect(saved.results[0]).toMatchObject({ suiteMs: 1000, collectMs: 40, setupMs: 20, tests: { passed: 1, skipped: 1 } });
      expect(raw).not.toContain(root);
      expect(raw).not.toContain('private test stdout');
      process.exitCode = 7;
      reporter.onFinished([file]);
      expect(JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))).toMatchObject({ complete: true, successful: false });
      reporter.onFinished([]);
      expect(process.exitCode).toBe(7);
      expect(JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))).toMatchObject({ complete: false, successful: false });
      process.exitCode = 0;
      process.env.LARK_CI_TIMING_REPORT = '.';
      reporter.onFinished([file]);
      expect(process.exitCode).toBe(1);
      const logged = vi.mocked(ctx.logger.log).mock.calls.at(-1)![0] as string;
      expect(JSON.parse(logged.slice('LARK_CI_TIMING_REPORT '.length))).toMatchObject({ complete: false, successful: false });
      reporter.onSpecsCollected([]);
      expect(state.selected).toEqual([]);
      expect(state.selectionCalls).toBe(0);
    } finally {
      if (previousOutput === undefined) delete process.env.LARK_CI_TIMING_REPORT;
      else process.env.LARK_CI_TIMING_REPORT = previousOutput;
      process.exitCode = previousExit;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
