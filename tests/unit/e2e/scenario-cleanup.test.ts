import { describe, expect, it } from 'vitest';
import { runWithCleanup } from '../../../e2e/test-bridge/scenario-cleanup';

describe('e2e scenario cleanup', () => {
  it('restores after a successful scenario', async () => {
    const calls: string[] = [];
    await expect(
      runWithCleanup(
        async () => {
          calls.push('work');
          return 'ok';
        },
        async () => {
          calls.push('cleanup');
        },
      ),
    ).resolves.toBe('ok');
    expect(calls).toEqual(['work', 'cleanup']);
  });

  it('restores proxy/faults when the scenario throws', async () => {
    const calls: string[] = [];
    await expect(
      runWithCleanup(
        async () => {
          calls.push('work');
          throw new Error('scenario failed');
        },
        async () => {
          calls.push('cleanup');
        },
      ),
    ).rejects.toThrow('scenario failed');
    expect(calls).toEqual(['work', 'cleanup']);
  });
});
