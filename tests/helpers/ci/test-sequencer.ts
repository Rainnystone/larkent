import { BaseSequencer, type WorkspaceSpec } from 'vitest/node';
import { identity, orderSpecs, planShards } from './test-plan';
import { runtimeState, toSpec } from './test-runtime';

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const shard = this.ctx.config.shard;
    if (!shard || !Number.isSafeInteger(shard.index) || shard.index < 1 || shard.index > shard.count) throw new Error('Invalid shard index');
    const specs = files.map(file => toSpec(file, this.ctx.config.root));
    const originals = new Map(specs.map((spec, index) => [identity(spec), files[index]!]));
    return planShards(specs, shard.count, runtimeState(this.ctx).weights)[shard.index - 1]!.items.map(item => originals.get(identity(item.spec))!);
  }

  override async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const state = runtimeState(this.ctx);
    const specs = files.map(file => toSpec(file, this.ctx.config.root));
    const originals = new Map(specs.map((spec, index) => [identity(spec), files[index]!]));
    const selected = orderSpecs(specs, state.weights).map(item => item.spec);
    // Calls arrive separately, potentially concurrently, for each Vitest pool.
    // Append, rather than overwrite, and keep original TestSpecification objects.
    state.selected.push(...selected);
    state.selectionCalls++;
    return selected.map(spec => originals.get(identity(spec))!);
  }
}
