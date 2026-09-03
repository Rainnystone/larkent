import type { CursorSandboxOption } from './options';

export interface BuildCursorArgsInput {
  prompt: string;
  sessionId?: string;
  model?: string;
  sandbox?: CursorSandboxOption;
}

export function assertCursorSandbox(sandbox?: CursorSandboxOption): void {
  if (sandbox && sandbox !== 'danger-full-access') {
    throw new Error(
      `Cursor CLI only supports full access; received sandbox ${sandbox}. ` +
        'Restricted modes are not mapped onto Cursor --sandbox because enabling it would block lark-cli network calls.',
    );
  }
}

/**
 * Cursor Agent CLI print-mode argv.
 *
 * Unattended Feishu bot: `--force` auto-approves tools, `--sandbox disabled`
 * so lark-cli can reach the network, `--approve-mcps` skips MCP prompts,
 * `--trust` skips the workspace trust dialog (headless-only flag).
 */
export function buildCursorArgs(input: BuildCursorArgsInput): string[] {
  assertCursorSandbox(input.sandbox);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--force',
    '--sandbox',
    'disabled',
    '--approve-mcps',
    '--trust',
  ];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  args.push(input.prompt);
  return args;
}
