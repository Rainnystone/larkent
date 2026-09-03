import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { looksLikeCursorBinary } from '../agent/cursor/binary';

export type AgentKind = 'claude' | 'codex' | 'kimi' | 'grok' | 'cursor';

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
  const candidates: Array<{ kind: AgentKind; command: string }> = [
    { kind: 'grok', command: process.env.LARK_CHANNEL_GROK_BIN ?? 'grok' },
    { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
    { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
    { kind: 'kimi', command: process.env.LARK_CHANNEL_KIMI_BIN ?? 'kimi' },
    { kind: 'cursor', command: process.env.LARK_CHANNEL_CURSOR_BIN ?? 'cursor-agent' },
  ];
  const detected: DetectedAgent[] = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command),
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
  try {
    return await resolveExecutablePath('cursor-agent');
  } catch {
    return resolveCursorAgentFallback();
  }
}

async function resolveCursorAgentFallback(): Promise<string> {
  const binaryPath = await resolveExecutablePath('agent');
  if (await looksLikeCursorBinary(binaryPath)) return binaryPath;
  throw new Error('executable not found: cursor-agent');
}
