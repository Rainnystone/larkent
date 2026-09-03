import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { looksLikeCursorBinary } from '../agent/cursor/binary';
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

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const detected: DetectedAgent[] = [];
  for (const kind of kindsInDetectionOrder()) {
    const descriptor = descriptorFor(kind);
    const command = process.env[descriptor.envBinVar] ?? descriptor.binaryNames[0];
    if (!command) continue;
    try {
      detected.push({
        kind,
        binaryPath: await resolveExecutablePath(command),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  if (!detected.some((d) => d.kind === 'cursor') && !process.env.LARK_CHANNEL_CURSOR_BIN) {
    try {
      detected.push({ kind: 'cursor', binaryPath: await resolveCursorAgentFallback() });
    } catch {
      // `agent` is a common name; ignore non-Cursor binaries.
    }
  }
  return detected;
}

/**
 * Same resolution onboard uses: `LARK_CHANNEL_CURSOR_BIN`, else `cursor-agent`,
 * else a verified Cursor `agent` binary. Runtime must call this rather than
 * hard-coding `cursor-agent`.
 */
export async function resolveCursorBinary(): Promise<string> {
  const explicit = process.env.LARK_CHANNEL_CURSOR_BIN;
  if (explicit) return resolveExecutablePath(explicit);
  const names = descriptorFor('cursor').binaryNames;
  try {
    return await resolveExecutablePath(names[0] ?? 'cursor-agent');
  } catch {
    return resolveCursorAgentFallback();
  }
}

async function resolveCursorAgentFallback(): Promise<string> {
  const fallback = descriptorFor('cursor').binaryNames[1] ?? 'agent';
  const binaryPath = await resolveExecutablePath(fallback);
  if (await looksLikeCursorBinary(binaryPath)) return binaryPath;
  throw new Error(`executable not found: ${descriptorFor('cursor').binaryNames[0] ?? 'cursor-agent'}`);
}
