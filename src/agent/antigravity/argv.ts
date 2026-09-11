export interface BuildAntigravityArgsInput {
  /**
   * Full prompt text (bridge system prompt already prefixed by the caller).
   * `agy -p` takes the prompt as a flag value; there is no `--rules` or
   * `--append-system-prompt` on Antigravity CLI 1.2.1.
   */
  prompt: string;
  /** Resume token from a previous run's `init` / `result.conversation_id`. */
  conversationId?: string;
  /** Forwarded to `--model`. Omitted uses the CLI / settings default. */
  model?: string;
}

/**
 * Antigravity CLI print-mode argv.
 *
 * Unattended Feishu bot: `--dangerously-skip-permissions` maps to
 * `permission_mode: always-proceed`. `--disable-slash-commands` keeps
 * user text from expanding into CLI slash commands. Resume is always
 * `--conversation <id>`, never `-c/--continue` (workspace last-session).
 */
export function buildAntigravityArgs(input: BuildAntigravityArgsInput): string[] {
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
  ];
  if (input.conversationId) args.push('--conversation', input.conversationId);
  if (input.model) args.push('--model', input.model);
  return args;
}
