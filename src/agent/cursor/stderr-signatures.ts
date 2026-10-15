import type { CliSignature } from '../cli-signatures';

export const cursorStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /RetriableError:\s*Connection stalled repeatedly/,
    cliVersion: 'cursor-agent (observed 2026-09-07..2026-10-15)',
    classify: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
    userMessage: '上游连接反复中断，可稍后重试',
  },
  {
    pattern: /stored authentication is invalid/i,
    cliVersion: 'cursor-agent (observed 2026-09-07..2026-10-15)',
    classify: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
    userMessage: 'CLI 登录已失效，需要重新登录后再试',
  },
]);
