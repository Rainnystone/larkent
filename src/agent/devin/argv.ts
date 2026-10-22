/** The prompt and session configuration travel over ACP stdin, never argv. */
export function buildDevinArgs(input: { sandbox?: boolean }): string[] {
  return [...(input.sandbox ? ['--sandbox'] : []), 'acp'];
}
