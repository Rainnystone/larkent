import type { CliSignature } from '../cli-signatures';

export const antigravityStderrSignatures: readonly CliSignature[] = Object.freeze([
  {
    pattern: /print timeout after .* returning partial output/,
    cliVersion: 'agy (observed 2026-09-07..2026-10-15)',
    classify: { kind: 'partial', retriable: true, needsHuman: false },
    userMessage: '输出不完整（打印超时），可稍后继续',
  },
  {
    pattern: /error:\s*interrupted/,
    cliVersion: 'agy (observed 2026-09-07..2026-10-15)',
    classify: {
      kind: 'interrupted',
      reason: { type: 'external-signal' },
      retriable: true,
      needsHuman: false,
    },
    userMessage: '运行被外部信号中断',
  },
]);
