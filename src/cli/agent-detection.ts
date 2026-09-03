import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import {
  descriptorFor,
  kindsInDetectionOrder,
  type AgentKind,
} from '../agent/registry';

export type { AgentKind };

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

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
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}

export async function resolveDescriptorBinary(kind: AgentKind, binaryPath?: string): Promise<string> {
  if (binaryPath) return resolveExecutablePath(binaryPath);
  const names = descriptorFor(kind).binaryNames;
  let lastError: Error | undefined;
  for (const name of names) {
    try {
      return await resolveExecutablePath(name);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`executable not found: ${names[0] ?? kind}`);
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const detected: DetectedAgent[] = [];
  for (const kind of kindsInDetectionOrder()) {
    const descriptor = descriptorFor(kind);
    const env = process.env[descriptor.envBinVar];
    try {
      detected.push({
        kind,
        binaryPath: env
          ? await resolveExecutablePath(env)
          : await resolveDescriptorBinary(kind),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  return detected;
}

export async function resolveCursorBinary(): Promise<string> {
  return resolveDescriptorBinary('cursor');
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
