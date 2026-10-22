import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import { compare, identity, planShards, readWeights, record, replay, verifyCoverage, type ScheduleSpec, type TimingSnapshot } from './test-plan';
import { loadSnapshot, toSpec, vitestVersion } from './test-runtime';
import { updateTimings, type TimingReport } from './test-timing-reporter';

export async function discover(root: string, config?: string): Promise<ScheduleSpec[]> {
  // listFiles globs metadata only: unlike collectTests, it does not load suites,
  // run setup files, start fixture processes, or make test network requests.
  const ctx = await createVitest('test', { root, config, watch: false, reporters: [] }, { server: { middlewareMode: true, hmr: false, watch: null } });
  try {
    const specs = await ctx.listFiles();
    return specs.map(spec => ({ ...toSpec(spec, ctx.config.root), size: statSync(spec.moduleId).size }));
  } finally { await ctx.close(); }
}

function snapshotForUpdate(data: unknown): TimingSnapshot {
  if (!record(data) || data.version !== 1 || data.metric !== 'suite-duration-ms' || data.vitestVersion !== vitestVersion || !Array.isArray(data.sources) || !record(data.platforms)) throw new Error('A valid compatible seed snapshot is required for an update');
  for (const [platform, costs] of Object.entries(data.platforms)) {
    if (!record(costs) || readWeights(data, platform, vitestVersion).warnings.length) throw new Error('Invalid seed timing estimates');
  }
  return data as unknown as TimingSnapshot;
}
function numberOption(value: string | undefined, fallback: number, label: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    platform: { type: 'string' }, shards: { type: 'string' }, workers: { type: 'string' },
    timings: { type: 'string' }, output: { type: 'string' }, observed: { type: 'string' },
    root: { type: 'string' }, config: { type: 'string' },
  } });
  const [command, ...files] = positionals;
  if (!['discover', 'verify', 'replay', 'update-timings'].includes(command ?? '')) throw new Error('Usage: ci:schedule discover|verify|replay|update-timings [--platform linux|darwin|win32] [--shards N] [--workers N] [--observed comma-separated-test-step-ms] [--output candidate.json] [report.json ...]');
  const root = resolve(values.root ?? '.');
  const timingPath = values.timings ?? 'tests/helpers/ci/test-timings.json';
  const snapshot = loadSnapshot(root, timingPath);
  let result: unknown;
  if (command === 'update-timings') {
    if (!values.output || !files.length) throw new Error('update-timings requires explicit --output candidate.json and complete shard report files');
    result = updateTimings(snapshotForUpdate(snapshot.data), files.map(file => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as TimingReport));
  } else {
    if (files.length) throw new Error('Unexpected positional arguments');
    const specs = await discover(root, values.config);
    const platform = values.platform ?? process.platform;
    const shards = numberOption(values.shards, platform === 'win32' ? 3 : 2, 'Shards');
    const weights = readWeights(snapshot.data, platform, vitestVersion);
    if (command === 'discover') result = specs;
    else if (command === 'verify') {
      const plan = planShards(specs, shards, weights);
      const diagnostics = verifyCoverage(specs, plan);
      if (diagnostics.length) throw new Error(diagnostics.join('\n'));
      result = { platform, vitestVersion, discoveredCount: specs.length, warnings: weights.warnings, exactCover: true, shards: plan.map(shard => ({ index: shard.index, files: shard.items.length, estimatedMs: shard.estimatedMs, missingEstimates: shard.items.filter(item => !item.measured).map(item => identity(item.spec)) })) };
    } else {
      if (!values.workers) throw new Error('replay requires explicit --workers per pool');
      const modeled = replay(specs, shards, numberOption(values.workers, 1, 'Workers'), weights);
      const observed = values.observed?.split(',').map(Number);
      if (observed && (observed.length !== shards || observed.some(value => !Number.isFinite(value) || value < 0))) throw new Error('--observed needs one nonnegative test-step millisecond value per shard');
      result = { platform, vitestVersion, discoveredCount: specs.length, warnings: weights.warnings, ...modeled, observedTestStepMs: observed ?? null, oldModelResidualMs: observed?.map((value, index) => value - modeled.builtin.shardsMs[index]!) ?? null, residualNote: 'Observed minus modeled old test step; includes excluded overhead, contention and timing-estimate error. Null when no measured baseline is supplied.' };
    }
  }
  if (values.output) {
    const output = resolve(root, values.output);
    if (output === resolve(root, timingPath) || output === resolve(root, 'tests/helpers/ci/test-timings.json')) throw new Error('Write a separate candidate file; never overwrite the checked-in timing snapshot');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Scheduling command failed'); process.exitCode = 1; });
}
