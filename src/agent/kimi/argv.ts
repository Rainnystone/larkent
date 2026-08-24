export interface BuildKimiArgsInput {
  /**
   * Full prompt text (bridge system prompt already prefixed by the caller).
   * Passed via argv: `kimi -p` does not read the prompt from stdin
   * (`-p -` is treated as a literal dash, verified against kimi 0.38.0).
   */
  prompt: string;
  /** Resume token from a previous run's `session.resume_hint` meta line. */
  sessionId?: string;
  /** Forwarded to `kimi -m`. Omitted uses the account's default_model. */
  model?: string;
}

export function buildKimiArgs(input: BuildKimiArgsInput): string[] {
  const args = ['-p', input.prompt, '--output-format', 'stream-json'];
  if (input.sessionId) args.push('-S', input.sessionId);
  if (input.model) args.push('-m', input.model);
  return args;
}
