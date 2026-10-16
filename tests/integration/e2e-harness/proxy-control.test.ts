import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  faultProxySpawnArgv,
  proxyStatePath,
  stopDetachedProxy,
  tsxCliPath,
} from '../../../e2e/test-bridge/proxy-control';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

describe('test-bridge proxy control', () => {
  it('invokes tsx via node rather than the pnpm .bin shell shim', () => {
    const { command, args } = faultProxySpawnArgv('/tmp/e2e-proxy-state');
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(tsxCliPath());
    expect(args[0]).toMatch(/tsx[/\\]dist[/\\]cli\.mjs$/);
    expect(args[0]).not.toMatch(/[/\\]\.bin[/\\]tsx$/);
  });

  it('removes proxy.json when the holder process is already gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-proxy-down-'));
    cleanups.push(dir);
    const dead = await spawnDeadPid();
    const file = proxyStatePath(dir);
    await writeFile(file, `${JSON.stringify({ pid: dead, url: 'http://127.0.0.1:9' })}\n`, { mode: 0o600 });
    await stopDetachedProxy(dir);
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.once('error', reject);
    child.once('exit', () => {
      if (!child.pid) {
        reject(new Error('dead pid helper did not spawn'));
        return;
      }
      resolve(child.pid);
    });
  });
}
