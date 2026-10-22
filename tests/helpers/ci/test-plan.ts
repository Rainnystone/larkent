import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export interface ScheduleSpec {
  path: string;
  project: string;
  pool: string;
  size?: number;
}
export interface TimingSnapshot {
  version: 1;
  metric: 'suite-duration-ms';
  vitestVersion: string;
  sources: { runId: string | number; headSha: string }[];
  platforms: Record<string, Record<string, number>>;
}
export interface Weights {
  costs: Map<string, number>;
  fallbackMs: number;
  warnings: string[];
}
export interface PlannedItem {
  spec: ScheduleSpec;
  estimatedMs: number;
  measured: boolean;
}
export interface PlannedShard {
  index: number;
  items: PlannedItem[];
  estimatedMs: number;
}
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Test paths must be repository-relative, non-empty paths');
  }
  return normalized;
}
export function relativePath(root: string, path: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '');
  const full = path.replace(/\\/g, '/');
  return normalizePath(full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full);
}
export function identity(spec: ScheduleSpec): string {
  return JSON.stringify([spec.project, spec.pool, normalizePath(spec.path)]);
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Timing history is advisory. Invalid history changes estimates, never discovery.
export function readWeights(data: unknown, platform: string, vitestVersion: string): Weights {
  const costs = new Map<string, number>();
  const warnings: string[] = [];
  if (!record(data) || data.version !== 1 || data.metric !== 'suite-duration-ms' || data.vitestVersion !== vitestVersion || !record(data.platforms)) {
    warnings.push('Timing snapshot absent, malformed, or incompatible with this Vitest version; using positive fallback estimates.');
  } else {
    const rows = data.platforms[platform];
    if (!record(rows)) warnings.push(`No timing estimates for ${platform}; using positive fallback estimates.`);
    else for (const [path, duration] of Object.entries(rows)) {
      try {
        const normalized = normalizePath(path);
        if (!positive(duration) || costs.has(normalized)) throw new Error('Invalid estimate');
        costs.set(normalized, duration);
      } catch {
        warnings.push('Ignored an invalid or duplicate timing estimate.');
      }
    }
  }
  return { costs, warnings: [...new Set(warnings)], fallbackMs: costs.size ? median([...costs.values()]) : 1000 };
}

function assertCount(count: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${label} must be a positive integer`);
}
function checkedSpecs(specs: ScheduleSpec[]): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    const key = identity(spec);
    if (seen.has(key)) throw new Error(`Duplicate test identity: ${key}`);
    seen.add(key);
  }
}
function groupByPool<T extends { pool: string }>(specs: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const spec of specs) {
    const group = groups.get(spec.pool) ?? [];
    group.push(spec);
    groups.set(spec.pool, group);
  }
  return new Map([...groups].sort(([a], [b]) => compare(a, b)));
}
function estimate(spec: ScheduleSpec, weights: Weights): PlannedItem {
  const cost = weights.costs.get(normalizePath(spec.path));
  return { spec, estimatedMs: cost ?? weights.fallbackMs, measured: cost !== undefined };
}
export function orderSpecs(specs: ScheduleSpec[], weights: Weights): PlannedItem[] {
  checkedSpecs(specs);
  return specs.map(spec => estimate(spec, weights)).sort((a, b) => b.estimatedMs - a.estimatedMs || compare(identity(a.spec), identity(b.spec)));
}

// Vitest invokes the sequencer independently for each pool. Mirror that partition
// in the offline planner; balancing a global list would not match actual execution.
export function planShards(specs: ScheduleSpec[], count: number, weights: Weights): PlannedShard[] {
  assertCount(count, 'Shard count');
  checkedSpecs(specs);
  const shards = Array.from({ length: count }, (_, index) => ({ index: index + 1, items: [] as PlannedItem[], estimatedMs: 0 }));
  for (const group of groupByPool(specs).values()) {
    const loads = Array<number>(count).fill(0);
    for (const item of orderSpecs(group, weights)) {
      let target = 0;
      for (let index = 1; index < count; index++) if (loads[index]! < loads[target]!) target = index;
      shards[target]!.items.push(item);
      shards[target]!.estimatedMs += item.estimatedMs;
      loads[target]! += item.estimatedMs;
    }
  }
  return shards;
}

export function verifyCoverage(specs: ScheduleSpec[], shards: PlannedShard[]): string[] {
  checkedSpecs(specs);
  const expected = new Set(specs.map(identity));
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const item of shards.flatMap(shard => shard.items)) {
    const key = identity(item.spec);
    if (!expected.has(key)) diagnostics.push(`Unexpected test: ${key}`);
    if (seen.has(key)) diagnostics.push(`Duplicate test: ${key}`);
    seen.add(key);
  }
  for (const key of expected) if (!seen.has(key)) diagnostics.push(`Missing test: ${key}`);
  return diagnostics;
}

// Vitest 2.1.9 BaseSequencer: SHA1 of the root-relative path INCLUDING its
// leading slash, equal-count contiguous slices, then cold-cache file-size order.
// Stable ties intentionally retain discovery/hash order just like Array.sort.
export function builtinShards(specs: ScheduleSpec[], count: number, weights: Weights): PlannedShard[] {
  assertCount(count, 'Shard count');
  checkedSpecs(specs);
  const shards = Array.from({ length: count }, (_, index) => ({ index: index + 1, items: [] as PlannedItem[], estimatedMs: 0 }));
  for (const group of groupByPool(specs).values()) {
    const hashed = group.map(spec => ({ spec, hash: createHash('sha1').update(`/${normalizePath(spec.path)}`).digest('hex') })).sort((a, b) => compare(a.hash, b.hash));
    const size = Math.ceil(group.length / count);
    for (let index = 0; index < count; index++) {
      const items = hashed.slice(size * index, size * (index + 1)).map(({ spec }) => spec).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).map(spec => estimate(spec, weights));
      shards[index]!.items.push(...items);
      shards[index]!.estimatedMs += items.reduce((total, item) => total + item.estimatedMs, 0);
    }
  }
  return shards;
}
function model(shards: PlannedShard[], workers: number): { shardsMs: number[]; wallMs: number } {
  const shardsMs = shards.map(shard => {
    const pools = groupByPool(shard.items.map(item => ({ ...item, pool: item.spec.pool })));
    return Math.max(0, ...[...pools.values()].map(items => {
      const lanes = Array<number>(workers).fill(0);
      for (const item of items) {
        let target = 0;
        for (let index = 1; index < workers; index++) if (lanes[index]! < lanes[target]!) target = index;
        lanes[target]! += item.estimatedMs;
      }
      return Math.max(...lanes);
    }));
  });
  return { shardsMs, wallMs: Math.max(0, ...shardsMs) };
}
export function replay(specs: ScheduleSpec[], count: number, workers: number, weights: Weights) {
  assertCount(workers, 'Workers');
  return {
    assumptions: 'suite-duration-only; fixed FIFO workers per pool; pools run concurrently without contention; cold built-in cache; excludes collection, setup, transform, process startup, job preparation and contention; predictions are not measured speedups',
    workersPerPool: workers,
    missingEstimates: specs.filter(spec => !weights.costs.has(normalizePath(spec.path))).map(identity),
    builtin: model(builtinShards(specs, count, weights), workers),
    weighted: model(planShards(specs, count, weights), workers),
  };
}
