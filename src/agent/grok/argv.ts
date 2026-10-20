export interface BuildGrokArgsInput {
  /**
   * Path to the prompt. `--prompt-file` starts headless the same way `-p`
   * does, without putting the prompt text on the process argv.
   */
  promptFile: string;
  /**
   * Extra system-prompt rules (`--rules`). Used for the bridge identity
   * prompt. Do not use `--system-prompt-override`: that replaces Grok's
   * coding system prompt.
   */
  rules: string;
  /**
   * Resume token from a previous run's `end.sessionId`.
   * Must be `-r/--resume`, never `-s/--session-id` (that flag only creates
   * a new UUID and errors if the id already exists).
   */
  sessionId?: string;
  /** Forwarded to `grok -m`. Omitted uses the CLI / config default. */
  model?: string;
  /**
   * When set, map the profile access mode onto `--permission-mode` and
   * `--sandbox`. Omitted keeps the historical unattended `--always-approve`.
   */
  permissionMode?: string;
  sandbox?: string;
}

export function buildGrokArgs(input: BuildGrokArgsInput): string[] {
  const args = [
    '--prompt-file',
    input.promptFile,
    '--output-format',
    'streaming-json',
    '--rules',
    input.rules,
  ];
  if (input.permissionMode) args.push('--permission-mode', input.permissionMode);
  if (input.sandbox) args.push('--sandbox', input.sandbox);
  // No access mode: unattended Feishu bot bypasses tool prompts.
  // `bypassPermissions` is that same mode, so it does not also pass the alias.
  if (!input.permissionMode && !input.sandbox) args.push('--always-approve');
  args.push('--no-auto-update');
  if (input.sessionId) args.push('-r', input.sessionId);
  if (input.model) args.push('-m', input.model);
  return args;
}
