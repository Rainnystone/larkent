import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TEST_BRIDGE_DIR, '..', '..');
export const EXAMPLE_CONFIG_PATH = join(REPO_ROOT, 'e2e', 'test-bridge.example.json');
export const LOCAL_DIR = join(REPO_ROOT, 'e2e', '.local');
export const DEFAULT_LOCAL_CONFIG = join(LOCAL_DIR, 'test-bridge.json');
export const SHIM_ENTRY = join(TEST_BRIDGE_DIR, 'shim.sh');
export const FAKE_CLI = join(TEST_BRIDGE_DIR, 'bin', 'fake-cli.mjs');

export function defaultDataRoot(instance: string, home = homedir()): string {
  return join(home, '.lark-channel-e2e', instance);
}

export function pidFilePath(dataRoot: string): string {
  return join(dataRoot, 'test-bridge.pid.json');
}

export function faultDirPath(dataRoot: string): string {
  return join(dataRoot, 'shim-faults');
}

export function resolveExistingPath(path: string, cwd = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

