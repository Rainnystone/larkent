import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Vitest, WorkspaceSpec } from 'vitest/node';
import { readWeights, relativePath, type ScheduleSpec, type Weights } from './test-plan';

export const vitestVersion: string = (createRequire(import.meta.url)('vitest/package.json') as { version: string }).version;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function loadSnapshot(root: string, path = 'tests/helpers/ci/test-timings.json'): { data: unknown; hash: string } {
  try {
    const raw = readFileSync(resolve(root, path), 'utf8');
    return { data: JSON.parse(raw) as unknown, hash: digest(raw) };
  } catch {
    return { data: undefined, hash: 'unavailable' };
  }
}
export function toSpec(spec: WorkspaceSpec, root: string): ScheduleSpec {
  return { path: relativePath(root, spec.moduleId), project: spec.project.name ?? '', pool: spec.pool };
}
interface RuntimeState {
  selected: ScheduleSpec[];
  selectionCalls: number;
  weights: Weights;
  snapshotHash: string;
}
const states = new WeakMap<Vitest, RuntimeState>();
export function runtimeState(ctx: Vitest): RuntimeState {
  let state = states.get(ctx);
  if (!state) {
    const snapshot = loadSnapshot(ctx.config.root);
    state = { selected: [], selectionCalls: 0, weights: readWeights(snapshot.data, process.platform, vitestVersion), snapshotHash: snapshot.hash };
    states.set(ctx, state);
  }
  return state;
}
