import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { checkAgentVersion } from '../agent/preflight';
import { descriptorFor, type AgentKind } from '../agent/registry';
import { spawnProcessSync } from '../platform/spawn';

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

function isCursorCliHelpText(help: string): boolean {
  return /--approve-mcps/i.test(help) && /(?:--output-format|stream-json)/i.test(help);
}

async function looksLikeCursorBinary(binaryPath: string): Promise<boolean> {
  const version = await checkAgentVersion({
    agentId: 'cursor',
    agentName: 'Cursor CLI',
    command: binaryPath,
    binaryPath,
    timeoutMs: 1500,
  }).catch(() => undefined);
  if (version && /cursor/i.test(version)) return true;
  try {
    const result = spawnProcessSync(binaryPath, ['--help'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    const help = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return isCursorCliHelpText(help);
  } catch {
    return false;
  }
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const detectOrder: AgentKind[] = ['grok', 'claude', 'codex', 'kimi', 'cursor'];
  const detected: DetectedAgent[] = [];
  for (const kind of detectOrder) {
    const envCommand = process.env[descriptorFor(kind).envBinVar];
    try {
      detected.push({
        kind,
        binaryPath: await resolveDetectedBinary(kind, envCommand),
      });
    } catch {}
  }
  return detected;
}

export async function resolveCursorBinary(): Promise<string> {
  return resolveDetectedBinary('cursor', process.env.LARK_CHANNEL_CURSOR_BIN);
}

export async function resolveCursorPathBinary(): Promise<string> {
  return resolveDetectedBinary('cursor', undefined);
}

export async function resolveEnvPinnedBinary(kind: AgentKind): Promise<string | undefined> {
  const command = process.env[descriptorFor(kind).envBinVar];
  if (!command) return undefined;
  try {
    return await resolveDetectedBinary(kind, command);
  } catch {
    return undefined;
  }
}

async function resolveDetectedBinary(kind: AgentKind, envCommand: string | undefined): Promise<string> {
  if (kind !== 'cursor') {
    return envCommand
      ? await resolveExecutablePath(envCommand)
      : await resolveFirstAvailableBinary(descriptorFor(kind).binaryNames);
  }
  if (envCommand) {
    const resolved = await resolveExecutablePath(envCommand);
    await assertCursorBinary(resolved, envCommand);
    return resolved;
  }
  let lastError: unknown;
  for (const name of descriptorFor('cursor').binaryNames) {
    try {
      const resolved = await resolveExecutablePath(name);
      await assertCursorBinary(resolved, name);
      return resolved;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`executable not found: ${descriptorFor('cursor').binaryNames.join(' / ')}`);
}

async function assertCursorBinary(resolved: string, command: string): Promise<void> {
  if (!isGenericAgentCommand(command) && !isGenericAgentCommand(resolved)) return;
  if (await looksLikeCursorBinary(resolved)) return;
  throw new Error('executable is not Cursor CLI');
}

function isGenericAgentCommand(command: string): boolean {
  return basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() === 'agent';
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
