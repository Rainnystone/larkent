import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, descriptorFor } from '../../../src/agent/registry';
import {
  EMPTY_AGENT_KINDS_ERROR,
  loadOnboardWizardSnapshot,
  mergeOnboardSnapshot,
  snapshotFromOnboardState,
  snapshotFromStateFetchError,
} from '../../../web/src/views/onboard-wizard-state';
import type { OnboardAgentChoice, OnboardState } from '../../../web/src/lib/types';

const kinds: OnboardAgentChoice[] = AGENT_KINDS.map((kind) => {
  const descriptor = descriptorFor(kind);
  return {
    kind,
    displayName: descriptor.displayName,
    requireInstalled: descriptor.requireInstalled,
  };
});

const loaded: OnboardState = {
  hasConfig: false,
  profiles: ['work'],
  detectedAgents: ['claude'],
  agentKinds: kinds,
};

describe('onboard wizard state fetch', () => {
  it('does not swallow a failed /api/onboard/state request as an empty usable list', async () => {
    const snapshot = await loadOnboardWizardSnapshot(async () => {
      throw new Error('HTTP 500');
    });
    expect(snapshot.agentKinds).toEqual([]);
    expect(snapshot.error).toBe('HTTP 500');
  });

  it('restores kinds on retry after a transient state fetch failure', async () => {
    let calls = 0;
    const get = async <T>(_path: string): Promise<T> => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return loaded as T;
    };

    const failed = await loadOnboardWizardSnapshot(get);
    expect(failed.agentKinds).toEqual([]);
    expect(failed.error).toBe('transient');

    const recovered = mergeOnboardSnapshot(failed, await loadOnboardWizardSnapshot(get));
    expect(recovered.agentKinds.map((choice) => choice.kind)).toEqual([...AGENT_KINDS]);
    expect(recovered.error).toBeNull();
    expect(recovered.existing).toEqual(['work']);
  });

  it('keeps last good kinds when a later refresh fails', () => {
    const previous = snapshotFromOnboardState(loaded);
    const merged = mergeOnboardSnapshot(previous, snapshotFromStateFetchError(new Error('transient')));
    expect(merged.agentKinds).toEqual(kinds);
    expect(merged.error).toBeNull();
  });

  it('treats a successful payload with empty agentKinds as unusable', () => {
    const snapshot = snapshotFromOnboardState({
      hasConfig: false,
      profiles: [],
      detectedAgents: [],
      agentKinds: [],
    });
    expect(snapshot.agentKinds).toEqual([]);
    expect(snapshot.error).toBe(EMPTY_AGENT_KINDS_ERROR);
  });

  it('OnboardWizard loads state through the snapshot helper and does not ignore fetch errors', () => {
    const source = readFileSync(join(process.cwd(), 'web/src/views/OnboardWizard.tsx'), 'utf8');
    expect(source).toContain('loadOnboardWizardSnapshot');
    expect(source).toContain('无法加载 agent 列表');
    expect(source).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  });
});
