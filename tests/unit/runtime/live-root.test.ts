import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLiveRootAllowed,
  defaultLiveRootDir,
  LiveRootGuardError,
} from '../../../src/runtime/live-root';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it.skipIf(process.platform === 'win32')(
    'refuses a missing data root whose ancestor symlink points into the live root',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'live-root-symlink-'));
      dirs.push(dir);
      const live = join(dir, 'live');
      await mkdir(live, { recursive: true });
      const link = join(dir, 'link-to-live');
      await symlink(live, link);
      expect(() =>
        assertLiveRootAllowed(join(link, 'missing', 'root'), {
          env: { LARKENT_INSTANCE: 'test' },
          liveRoot: live,
        }),
      ).toThrow(LiveRootGuardError);
    },
  );
});
