import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLiveRootAllowed,
  defaultLiveRootDir,
  LiveRootGuardError,
} from '../../../src/runtime/live-root';

describe('live root guard', () => {
  const liveRoot = defaultLiveRootDir();

  it('refuses a test instance whose data root is the live root', () => {
    expect(() =>
      assertLiveRootAllowed(liveRoot, { env: { LARKENT_INSTANCE: 'test' } }),
    ).toThrow(LiveRootGuardError);
    expect(() =>
      assertLiveRootAllowed(join(liveRoot, 'profiles', 'claude'), {
        instance: 'test',
      }),
    ).toThrow(LiveRootGuardError);
  });

  it('does not affect a non-test instance even when the data root is live', () => {
    expect(() => assertLiveRootAllowed(liveRoot, { env: {} })).not.toThrow();
    expect(() =>
      assertLiveRootAllowed(liveRoot, { instance: 'live', env: {} }),
    ).not.toThrow();
  });

  it('allows a test instance on an isolated data root', () => {
    expect(() =>
      assertLiveRootAllowed(join(homedir(), '.lark-channel-e2e', 't1'), {
        env: { LARKENT_INSTANCE: 'test' },
      }),
    ).not.toThrow();
  });
});
