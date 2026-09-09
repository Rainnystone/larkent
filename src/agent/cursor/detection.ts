import { basename } from 'node:path';
import { resolveExecutablePath } from '../../platform/executable';
import { spawnProcessSync } from '../../platform/spawn';
import { checkAgentVersion } from '../preflight';
import { cursorMetadata } from './metadata';

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

export async function detectCursorBinary(envCommand?: string): Promise<string> {
  if (envCommand) {
    const resolved = await resolveExecutablePath(envCommand);
    await assertCursorBinary(resolved, envCommand);
    return resolved;
  }
  let lastError: unknown;
  for (const name of cursorMetadata.binaryNames) {
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
    : new Error(`executable not found: ${cursorMetadata.binaryNames.join(' / ')}`);
}

async function assertCursorBinary(resolved: string, command: string): Promise<void> {
  if (!isGenericAgentCommand(command) && !isGenericAgentCommand(resolved)) return;
  if (await looksLikeCursorBinary(resolved)) return;
  throw new Error('executable is not Cursor CLI');
}

function isGenericAgentCommand(command: string): boolean {
  return basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() === 'agent';
}
