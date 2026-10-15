import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
  const live = resolvePossiblyMissingPath(input.liveRoot ?? defaultLiveRootDir());
  const root = resolvePossiblyMissingPath(rootDir);
  if (root === live || isPathInside(root, live)) {
    throw new LiveRootGuardError(rootDir);
  }
}

/**
 * Canonicalize `path`, including when some trailing segments do not exist yet:
 * realpath the nearest existing ancestor and append the missing suffix so a
 * symlink ancestor cannot hide containment of the live data root.
 */
export function resolvePossiblyMissingPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      if (existsSync(current)) {
        const real = realpathSync(current);
        return missing.length === 0 ? real : join(real, ...missing);
      }
    } catch {
      /* keep walking toward the filesystem root */
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
}

function isPathInside(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
