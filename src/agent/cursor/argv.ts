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
}

/**
 * Cursor Agent CLI print-mode argv.
 *
 * Unattended Feishu bot: `--force` auto-approves tools, `--sandbox disabled`
 * so lark-cli can reach the network, `--approve-mcps` skips MCP prompts,
 * `--trust` skips the workspace trust dialog (headless-only flag).
 */
export function buildCursorArgs(input: BuildCursorArgsInput): string[] {
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
