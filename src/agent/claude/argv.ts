import { CLAUDE_DEFAULT_PERMISSION_MODE, type ClaudePermissionMode } from './options';

export interface BuildClaudeArgsInput {
  systemPromptFile: string;
  permissionMode?: ClaudePermissionMode;
  sessionId?: string;
  model?: string;
}

export function buildClaudeArgs(input: BuildClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    input.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
    '--append-system-prompt-file',
    input.systemPromptFile,
  ];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  return args;
}
