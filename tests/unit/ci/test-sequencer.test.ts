import { describe, expect, it, vi } from 'vitest';
import { BaseSequencer, type Vitest, type WorkspaceSpec } from 'vitest/node';
import { resolve } from 'node:path';
import { builtinShards, identity, planShards, readWeights, type ScheduleSpec } from '../../helpers/ci/test-plan';
import DurationSequencer from '../../helpers/ci/test-sequencer';
import { runtimeState, toSpec } from '../../helpers/ci/test-runtime';

function context(index: number, count = 2): Vitest {
  return {
    config: { root: process.cwd(), shard: { index, count } },
    cache: { getFileTestResults: () => undefined, getFileStats: (key: string) => ({ size: key.includes('large') ? 100 : 10 }) },
  } as unknown as Vitest;
}
function runnerSpec(path: string, pool = 'threads', project = ''): WorkspaceSpec {
  return { moduleId: resolve(path), pool, project: { name: project } } as unknown as WorkspaceSpec;
}

describe('Vitest scheduling adapters', () => {
  it('returns original specification objects with exact shared-planner membership and ordering', async () => {
    const files = ['small-a', 'large-b', 'small-c', 'small-d'].map(path => runnerSpec(path));
    for (const index of [1, 2]) {
      const ctx = context(index);
      const state = runtimeState(ctx);
      state.weights = readWeights({ version: 1, metric: 'suite-duration-ms', vitestVersion: '2.1.9', platforms: { linux: { 'large-b': 20, 'small-a': 10, 'small-c': 3, 'small-d': 2 } } }, 'linux', '2.1.9');
      const planned = planShards(files.map(file => toSpec(file, ctx.config.root)), 2, state.weights)[index - 1]!;
      const sequencer = new DurationSequencer(ctx);
      const actual = await sequencer.sort(await sequencer.shard(files));
      expect(actual.map(file => identity(toSpec(file, ctx.config.root)))).toEqual(planned.items.map(item => identity(item.spec)));
      for (const file of actual) expect(files.includes(file)).toBe(true);
    }
  });

  it('accumulates concurrent per-pool manifests rather than replacing the first pool', async () => {
    const ctx = context(1);
    const sequencer = new DurationSequencer(ctx);
    const groups = ['threads', 'forks'].map(pool => ['a', 'b', 'c'].map(path => runnerSpec(path, pool)));
    const selected = await Promise.all(groups.map(async files => sequencer.sort(await sequencer.shard(files))));
    expect(runtimeState(ctx).selected.map(identity).sort()).toEqual(selected.flat().map(file => identity(toSpec(file, ctx.config.root))).sort());
    expect(new Set(runtimeState(ctx).selected.map(spec => spec.pool))).toEqual(new Set(['threads', 'forks']));
  });

  it('matches the installed Vitest BaseSequencer cold hash and size ordering', async () => {
    const files = ['a.test.ts', 'large-b.test.ts', 'c.test.ts', 'd.test.ts', 'large-e.test.ts'].map(path => runnerSpec(path));
    const specs: ScheduleSpec[] = files.map(file => ({ ...toSpec(file, process.cwd()), size: file.moduleId.includes('large') ? 100 : 10 }));
    const expected = builtinShards(specs, 3, readWeights(undefined, 'linux', '2.1.9'));
    for (const index of [1, 2, 3]) {
      const actual = await new BaseSequencer(context(index, 3)).shard(files).then(files => new BaseSequencer(context(index, 3)).sort(files));
      expect(actual.map(file => identity(toSpec(file, process.cwd())))).toEqual(expected[index - 1]!.items.map(item => identity(item.spec)));
    }
  });

  it('rejects invalid shard index and duplicate identities before mapping originals', async () => {
    await expect(new DurationSequencer(context(0)).shard([runnerSpec('a')])).rejects.toThrow(/index/i);
    await expect(new DurationSequencer(context(1)).shard([runnerSpec('a'), runnerSpec('a')])).rejects.toThrow(/duplicate/i);
  });
});


describe('weighted configuration', () => {
  it('retains GitHub annotations while leaving ordinary local defaults untouched', async () => {
    try {
      vi.stubEnv('LARK_CI_SCHEDULER', 'weighted');
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      vi.resetModules();
      const weighted = (await import('../../../vitest.config')).default;
      expect(weighted.test?.reporters).toEqual(expect.arrayContaining(['default', 'github-actions']));
      vi.stubEnv('LARK_CI_SCHEDULER', '');
      vi.resetModules();
      const builtin = (await import('../../../vitest.config')).default;
      expect(builtin.test?.sequence).toBeUndefined();
      expect(builtin.test?.reporters).toBeUndefined();
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
