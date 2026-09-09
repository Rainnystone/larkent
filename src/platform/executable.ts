import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export async function resolveExecutablePath(command: string): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw new Error(`executable not found: ${command}`);
}

export async function resolveFirstAvailableBinary(names: readonly string[]): Promise<string> {
  let lastError: unknown;
  for (const name of names) {
    try {
      return await resolveExecutablePath(name);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`executable not found: ${names.join(' / ')}`);
}

function executableCandidates(dir: string, command: string): string[] {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join(dir, `${command}${ext}`));
  }
  return candidates;
}

function pathExts(): string[] {
  return (process.env.PATHEXT ?? '')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}
