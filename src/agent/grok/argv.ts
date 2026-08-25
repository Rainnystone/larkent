export interface BuildGrokArgsInput {
  /**
   * User / bridge prompt. Grok `-p` does not read stdin
   * (headless docs: piped stdin is ignored), so this travels via argv.
   */
  prompt: string;
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
}

export function buildGrokArgs(input: BuildGrokArgsInput): string[] {
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'streaming-json',
    '--rules',
    input.rules,
    // Unattended Feishu bot: always bypass tool prompts. Restricted
    // profile access modes are not mapped onto Grok flags.
    '--always-approve',
    '--no-auto-update',
  ];
  if (input.sessionId) args.push('-r', input.sessionId);
  if (input.model) args.push('-m', input.model);
  return args;
}
