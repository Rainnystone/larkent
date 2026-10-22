import type { CliSignature } from '../cli-signatures';

/** Unauthenticated stderr from devin 3000.x; network transients are appended globally. */
export const devinStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /not authenticated|authentication required|auth login|unauthorized/i,
    cliVersion: 'devin 3000.x (observed 2026-10-21)',
    classify: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
    userMessage: 'Devin CLI 未登录或凭据失效，请先在终端运行 devin auth login',
  },
]);
