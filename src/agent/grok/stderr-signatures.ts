import type { CliSignature } from '../cli-signatures';

/** Synthetic auth rule, plus failures observed on grok 1.0.41. */
export const grokStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /unauthorized:\s*invalid API key/i,
    cliVersion: 'synthetic',
    classify: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
    userMessage: 'CLI 认证失败，需要检查登录状态',
    synthetic: true,
  },
  {
    pattern: /unknown model id/i,
    cliVersion: 'grok 1.0.41',
    classify: { kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: true },
    userMessage: '未知模型（unknown model id）。请改用 grok models 列出的模型。',
  },
]);
