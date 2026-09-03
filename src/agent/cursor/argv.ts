import type { CodexSandboxMode } from '../../config/permissions';

export interface BuildCursorArgsInput {
  /**
   * Full prompt text (bridge system prompt already prefixed by the caller).
   * Cursor's `-p/--print` is a boolean flag; the prompt is a positional argv
   * element. There is no `--append-system-prompt` (verified against Cursor
   * CLI docs and community reports), so the bridge prompt travels here.
   */
  prompt: string;
  /** Resume token from a previous run's `system.init` / `result.session_id`. */
  sessionId?: string;
  /** Forwarded to `--model`. Omitted uses the account default. */
  model?: string;
  /**
   * Policy sandbox from RunExecutor. Cursor's unattended flags disable its
   * own sandbox so lark-cli can use the network; restricted modes are not
   * mapped (enabled Cursor sandbox would block those calls).
   */
  sandbox?: CodexSandboxMode;
}

/**
 * Cursor print mode always runs `--force --sandbox disabled`. That is full
 * host access, so reject read-only / workspace-write rather than silently
 * ignoring the profile ceiling.
 */
export function assertCursorSandbox(sandbox?: CodexSandboxMode): void {
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
