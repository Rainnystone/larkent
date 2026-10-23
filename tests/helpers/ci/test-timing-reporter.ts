import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { File, Task, SerializedTestSpecification } from 'vitest';
import type { Reporter } from 'vitest/reporters';
import type { Vitest } from 'vitest/node';
import { compare, identity, median, positive, relativePath, type ScheduleSpec, type TimingSnapshot } from './test-plan';
import { digest, runtimeState, vitestVersion } from './test-runtime';

type Outcome = 'pass' | 'fail' | 'skip' | 'todo' | 'incomplete';
interface Counts { passed: number; failed: number; skipped: number; todo: number; incomplete: number }
export interface TimingResult extends ScheduleSpec {
  outcome: Outcome;
  suiteMs: number | null;
  collectMs: number | null;
  setupMs: number | null;
  tests: Counts;
}
export interface TimingReport {
  version: 1;
  metric: 'suite-duration-ms';
  vitestVersion: string;
  source: { headSha: string | null; runId: string | null; runAttempt: string | null };
  environment: {
    platform: string; arch: string; node: string; cpus: number; fileParallelism: boolean;
    workers: Record<string, { min: number | null; max: number | null; isolated: boolean }>;
  };
  shard: { index: number; count: number };
  discoveryHash: string;
  discoveredCount: number;
  snapshotHash: string;
  configurationHash: string;
  sampleEligible: boolean;
  selected: ScheduleSpec[];
  results: TimingResult[];
  complete: boolean;
  successful: boolean;
  diagnostics: string[];
  elapsedMs: number;
}

export function reconcileResults(selected: ScheduleSpec[], results: TimingResult[], errorCount: number) {
  const expected = new Set<string>();
  const diagnostics: string[] = [];
  for (const spec of selected) {
    const key = identity(spec);
    if (expected.has(key)) diagnostics.push(`Duplicate selection: ${key}`);
    expected.add(key);
  }
  const seen = new Set<string>();
  for (const result of results) {
    const key = identity(result);
    if (seen.has(key)) diagnostics.push(`Duplicate outcome: ${key}`);
    if (!expected.has(key)) diagnostics.push(`Unexpected outcome: ${key}`);
    if (!['pass', 'fail', 'skip', 'todo'].includes(result.outcome) || result.tests.incomplete > 0) diagnostics.push(`Incomplete outcome: ${key}`);
    seen.add(key);
  }
  for (const key of expected) if (!seen.has(key)) diagnostics.push(`Missing outcome: ${key}`);
  if (errorCount) diagnostics.push(`${errorCount} unhandled runner error(s)`);
  const complete = diagnostics.length === 0;
  return { complete, successful: complete && results.every(result => result.outcome !== 'fail' && result.tests.failed === 0), diagnostics };
}
function outcome(task: Task): Outcome {
  const state = task.result?.state ?? task.mode;
  return ['pass', 'fail', 'skip', 'todo'].includes(state) ? state as Outcome : 'incomplete';
}
function countTests(tasks: Task[], counts: Counts = { passed: 0, failed: 0, skipped: 0, todo: 0, incomplete: 0 }): Counts {
  for (const task of tasks) {
    if (task.type === 'suite') countTests(task.tasks, counts);
    else {
      const state = outcome(task);
      counts[state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : state === 'skip' ? 'skipped' : state]++;
    }
  }
  return counts;
}
const finiteTiming = (value: number | undefined): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function resultFromFile(file: File, root: string, selected: ScheduleSpec[] = []): TimingResult {
  const spec = { path: relativePath(root, file.filepath), project: file.projectName ?? '', pool: file.pool ?? 'forks' };
  // Vitest 2.1.9 vmForks workers report their pool as "forks". Correct only
  // an unambiguous selected identity; never globally rename genuine forks.
  if (!selected.some(item => identity(item) === identity(spec)) && spec.pool === 'forks') {
    const candidates = selected.filter(item => item.path === spec.path && item.project === spec.project);
    if (candidates.length === 1 && candidates[0]!.pool === 'vmForks') spec.pool = 'vmForks';
  }
  return {
    ...spec,
    outcome: outcome(file), suiteMs: finiteTiming(file.result?.duration), collectMs: finiteTiming(file.collectDuration), setupMs: finiteTiming(file.setupDuration),
    tests: countTests(file.tasks),
  };
}
function sourceRevision(root: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[a-f\d]{40,64}$/.test(sha) ? sha : null;
  } catch { return null; }
}
function workerSettings(ctx: Vitest, pools: string[], cpus: number): TimingReport['environment']['workers'] {
  const config = ctx.config;
  const fallback = config.watch ? Math.max(Math.floor(cpus / 2), 1) : Math.max(cpus - 1, 1);
  const workers: TimingReport['environment']['workers'] = {};
  for (const pool of pools) {
    const options = config.poolOptions?.[pool as 'threads' | 'forks' | 'vmThreads' | 'vmForks'] as { minThreads?: number; maxThreads?: number; minForks?: number; maxForks?: number; singleThread?: boolean; singleFork?: boolean; isolate?: boolean } | undefined;
    const known = ['threads', 'forks', 'vmThreads', 'vmForks'].includes(pool);
    const single = options?.singleFork || options?.singleThread || !config.fileParallelism;
    workers[pool] = {
      min: known ? single ? 1 : options?.minThreads ?? (pool === 'vmForks' ? options?.maxForks : options?.minForks) ?? config.minWorkers ?? fallback : null,
      max: known ? single ? 1 : options?.maxThreads ?? options?.maxForks ?? config.maxWorkers ?? fallback : null,
      isolated: pool === 'vmForks' || pool === 'vmThreads' ? false : options?.isolate ?? config.isolate,
    };
  }
  return workers;
}

function configurationHash(ctx: Vitest): string {
  const projects = ctx.projects?.map(project => project.config) ?? [ctx.config];
  // Bounded resolved settings only: never include env, credentials, test stdout,
  // or the full config object. Source revision and discovery are recorded apart.
  return digest(JSON.stringify(projects.map(config => ({
    name: config.name, include: config.include, exclude: config.exclude,
    setupFiles: config.setupFiles.map(path => path.replace(/\\/g, '/').replace(ctx.config.root.replace(/\\/g, '/'), '<root>')),
    pool: config.pool, poolMatchGlobs: config.poolMatchGlobs,
    environment: config.environment, environmentMatchGlobs: config.environmentMatchGlobs,
    isolate: config.isolate, testTimeout: config.testTimeout, hookTimeout: config.hookTimeout,
    maxConcurrency: config.maxConcurrency, sequence: { hooks: config.sequence.hooks, setupFiles: config.sequence.setupFiles, concurrent: config.sequence.concurrent },
    testNamePattern: String(ctx.config.testNamePattern ?? ''),
  }))));
}

export default class TimingReporter implements Reporter {
  private ctx!: Vitest;
  private discovered: ScheduleSpec[] = [];
  private started = performance.now();
  onInit(ctx: Vitest): void { this.ctx = ctx; }
  onSpecsCollected(specs: SerializedTestSpecification[] = []): void {
    this.started = performance.now();
    runtimeState(this.ctx).selected.length = 0;
    runtimeState(this.ctx).selectionCalls = 0;
    this.discovered = specs.map(([project, path, options]) => ({ path: relativePath(this.ctx.config.root, path), project: project.name ?? '', pool: options.pool }));
  }
  onFinished(files: File[] = [], errors: unknown[] = []): void {
    const state = runtimeState(this.ctx);
    const results = files.map(file => resultFromFile(file, this.ctx.config.root, state.selected)).sort((a, b) => compare(identity(a), identity(b)));
    const reconciliation = reconcileResults(state.selected, results, errors.length);
    if (!state.selectionCalls && this.discovered.length) {
      reconciliation.complete = false;
      reconciliation.successful = false;
      reconciliation.diagnostics.push('No selected manifest was recorded by the weighted sequencer');
    }
    const cpus = availableParallelism();
    const report: TimingReport = {
      version: 1, metric: 'suite-duration-ms', vitestVersion,
      source: { headSha: sourceRevision(this.ctx.config.root), runId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID! : null, runAttempt: /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ? process.env.GITHUB_RUN_ATTEMPT! : null },
      environment: { platform: process.platform, arch: process.arch, node: process.version, cpus, fileParallelism: this.ctx.config.fileParallelism, workers: workerSettings(this.ctx, [...new Set(this.discovered.map(spec => spec.pool))].sort(compare), cpus) },
      shard: this.ctx.config.shard ?? { index: 1, count: 1 },
      discoveryHash: digest(JSON.stringify(this.discovered.map(identity).sort(compare))), discoveredCount: this.discovered.length,
      snapshotHash: state.snapshotHash,
      configurationHash: configurationHash(this.ctx),
      sampleEligible: !this.ctx.config.testNamePattern,
      selected: [...state.selected].sort((a, b) => compare(identity(a), identity(b))),
      results, ...reconciliation, elapsedMs: performance.now() - this.started,
    };
    if (process.exitCode) report.successful = false;
    // Never reset Vitest's failure status. Incomplete evidence is also a failure,
    // rather than a success-looking report that could train bad scheduling data.
    if (!report.successful && !process.exitCode) process.exitCode = 1;
    for (const warning of state.weights.warnings) this.ctx.logger.warn(`[ci-timing] ${warning}`);
    const output = resolve(this.ctx.config.root, process.env.LARK_CI_TIMING_REPORT ?? `.ci-timings/report-${process.platform}-${report.shard.index}-of-${report.shard.count}.json`);
    try {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(report)}\n`);
    } catch {
      report.complete = false;
      report.successful = false;
      report.diagnostics.push('Could not write the local timing report');
      if (!process.exitCode) process.exitCode = 1;
      this.ctx.logger.error('[ci-timing] Could not write the local timing report');
    }
    // Compact, machine-readable evidence in existing job logs: no artifact upload,
    // credentials, absolute filesystem paths, assertion errors, or test stdout.
    this.ctx.logger.log(`LARK_CI_TIMING_REPORT ${JSON.stringify(report)}`);
  }
}

// Only explicit update-timings uses this. Never invoked by a normal test run.
export function updateTimings(seed: TimingSnapshot, reports: TimingReport[]): TimingSnapshot {
  if (!reports.length) throw new Error('At least one complete report cohort is required');
  const cohorts = new Map<string, TimingReport[]>();
  const platformConfigurations = new Map<string, string>();
  for (const report of reports) {
    if (report.version !== 1 || report.metric !== 'suite-duration-ms' || report.vitestVersion !== seed.vitestVersion) throw new Error('Incompatible timing report');
    if (!report.sampleEligible || !report.configurationHash) throw new Error('Filtered or missing-configuration reports are ineligible for timing updates');
    const check = reconcileResults(report.selected, report.results, 0);
    if (!report.complete || !check.complete || report.diagnostics.length) throw new Error('Incomplete timing report');
    if (!report.successful || !check.successful) throw new Error('Only successful timing reports may update history');
    if (!report.source.headSha || !report.source.runId) throw new Error('A verified source revision and run ID are required for a report cohort');
    const compatibility = JSON.stringify([report.vitestVersion, report.environment, report.shard.count, report.configurationHash, report.discoveryHash, report.snapshotHash, report.discoveredCount]);
    const prior = platformConfigurations.get(report.environment.platform);
    if (prior && prior !== compatibility) throw new Error('Incompatible execution configuration across same-platform report cohorts');
    platformConfigurations.set(report.environment.platform, compatibility);
    const key = JSON.stringify([report.source, compatibility]);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(report);
    cohorts.set(key, cohort);
  }
  const samples = new Map<string, Map<string, number[]>>();
  for (const cohort of cohorts.values()) {
    const first = cohort[0]!;
    const indices = new Set<number>();
    const identities = new Set<string>();
    for (const report of cohort) {
      if (indices.has(report.shard.index)) throw new Error('Duplicate shard in report cohort');
      if (!Number.isSafeInteger(report.shard.index) || report.shard.index < 1 || report.shard.index > report.shard.count) throw new Error('Invalid shard in report cohort');
      indices.add(report.shard.index);
      for (const spec of report.selected) {
        const key = identity(spec);
        if (identities.has(key)) throw new Error('Duplicate test in report cohort');
        identities.add(key);
      }
    }
    if (indices.size !== first.shard.count || identities.size !== first.discoveredCount || digest(JSON.stringify([...identities].sort(compare))) !== first.discoveryHash) throw new Error('Incomplete or incompatible report cohort');
    // A path may exist in several projects/pools. Keep separate identities during
    // validation; use the median of valid observations for the advisory path cost.
    const platformSamples = samples.get(first.environment.platform) ?? new Map<string, number[]>();
    for (const report of cohort) for (const result of report.results) {
      if (result.outcome !== 'pass' || !positive(result.suiteMs)) continue;
      const values = platformSamples.get(result.path) ?? [];
      values.push(result.suiteMs);
      platformSamples.set(result.path, values);
    }
    samples.set(first.environment.platform, platformSamples);
  }
  const platforms = structuredClone(seed.platforms);
  for (const [platform, paths] of samples) {
    platforms[platform] ??= {};
    for (const [path, values] of paths) platforms[platform]![path] = median(values);
    platforms[platform] = Object.fromEntries(Object.entries(platforms[platform]!).sort(([a], [b]) => compare(a, b)));
  }
  const sources = new Map(seed.sources.map(source => [`${source.runId}:${source.headSha}`, source]));
  for (const report of reports) sources.set(`${report.source.runId}:${report.source.headSha}`, { runId: report.source.runId!, headSha: report.source.headSha! });
  return { ...seed, sources: [...sources.values()], platforms };
}
