import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shouldRewriteTestBridgeConfig } from '../../../e2e/test-bridge/driver';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('e2e up config reuse', () => {
  it('keeps an existing config.json unless --reset-config is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-up-config-'));
    dirs.push(dir);
    const configPath = join(dir, 'config.json');

    expect(await shouldRewriteTestBridgeConfig(configPath)).toBe(true);

    await writeFile(configPath, '{"kept":true}\n', { mode: 0o600 });
    expect(await shouldRewriteTestBridgeConfig(configPath)).toBe(false);
    expect(await shouldRewriteTestBridgeConfig(configPath, false)).toBe(false);
    expect(await shouldRewriteTestBridgeConfig(configPath, true)).toBe(true);
  });

  it('rewrites when the data root has no config yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-up-empty-'));
    dirs.push(dir);
    await mkdir(join(dir, 'nested'), { recursive: true });
    expect(await shouldRewriteTestBridgeConfig(join(dir, 'nested', 'config.json'))).toBe(true);
  });
});
