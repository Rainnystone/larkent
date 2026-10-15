import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class LiveRootGuardError extends Error {
  constructor(readonly rootDir: string) {
    super('test instance refused to use the live data root');
    this.name = 'LiveRootGuardError';
  }
}

export function defaultLiveRootDir(home = homedir()): string {
  return join(home, '.lark-channel');
}

export function isTestInstance(input: {
  env?: NodeJS.ProcessEnv;
  instance?: string;
} = {}): boolean {
  const envVal = (input.env ?? process.env).LARKENT_INSTANCE;
  return envVal === 'test' || input.instance === 'test';
}

/**
 * Test instances may not share the default live data root (`~/.lark-channel`)
 * or any path inside it. Non-test instances are unchanged.
 */
export function assertLiveRootAllowed(
  rootDir: string,
  input: {
    env?: NodeJS.ProcessEnv;
    instance?: string;
    liveRoot?: string;
  } = {},
): void {
  if (!isTestInstance(input)) return;
  const live = resolvedPath(input.liveRoot ?? defaultLiveRootDir());
  const root = resolvedPath(rootDir);
  if (root === live || isPathInside(root, live)) {
    throw new LiveRootGuardError(rootDir);
  }
}

function resolvedPath(path: string): string {
  const absolute = resolve(path);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    /* fall through */
  }
  return absolute;
}

function isPathInside(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
