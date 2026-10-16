import type { CliSignature } from '../cli-signatures';

/** Synthetic only — not observed in real bridge logs. */
export const grokStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /unauthorized:\s*invalid API key/i,
    cliVersion: 'synthetic',
    classify: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
    userMessage: 'CLI 认证失败，需要检查登录状态',
    synthetic: true,
  },
]);
