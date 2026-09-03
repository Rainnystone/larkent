import { spawnProcessSync } from '../../platform/spawn';
import { checkAgentVersion } from '../preflight';

/**
 * Cursor CLI `--help` mentions these flags; random PATH binaries named `agent`
 * do not. Version banners are often just `YYYY.MM.DD[-sha]` without the word
 * "cursor", so help text is the discriminator when `--version` is generic.
 */
export function isCursorCliHelpText(help: string): boolean {
  return /--approve-mcps/i.test(help) && /(?:--output-format|stream-json)/i.test(help);
}

export async function looksLikeCursorBinary(binaryPath: string): Promise<boolean> {
  try {
    const version = await checkAgentVersion({
      agentId: 'cursor',
      agentName: 'Cursor CLI',
      command: binaryPath,
      binaryPath,
    });
    if (/cursor/i.test(version)) return true;
  } catch {
    // Fall through to --help; some Cursor builds put the product name only there.
  }
  try {
    const result = spawnProcessSync(binaryPath, ['--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const help = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return isCursorCliHelpText(help);
  } catch {
    return false;
  }
}
