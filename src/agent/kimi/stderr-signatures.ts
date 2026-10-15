import type { CliSignature } from '../cli-signatures';

/** Synthetic only — not observed in real bridge logs. */
export const kimiStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /rate limit exceeded/i,
    cliVersion: 'synthetic',
    classify: { kind: 'failed', cause: 'quota', retriable: false, needsHuman: true },
    userMessage: '额度或速率受限，需要人工处理',
    synthetic: true,
  },
]);
