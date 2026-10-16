import { log, reportMetric } from '../core/logger';

export type SignatureFailedCause =
  | 'transient-upstream'
  | 'auth-required'
  | 'quota'
  | 'killed-externally'
  | 'unclassified';

export type SignatureClassify =
  | { kind: 'partial'; retriable: boolean; needsHuman: boolean }
  | { kind: 'failed'; cause: SignatureFailedCause; retriable: boolean; needsHuman: boolean }
  | { kind: 'interrupted'; reason: { type: 'external-signal' }; retriable: boolean; needsHuman: boolean };

export interface CliSignature {
  pattern: RegExp;
  cliVersion: string;
  classify: SignatureClassify;
  userMessage: string;
  synthetic?: boolean;
}

export const UNCLASSIFIED_USER_MESSAGE = 'agent 运行失败';

export const NETWORK_TRANSIENT_USER_MESSAGE = '网络连接中断，可稍后继续';

/** TLS / socket failures from a CLI's upstream. Shared across every agent. */
export const NETWORK_TRANSIENT_SIGNATURES: readonly CliSignature[] = Object.freeze([
  {
    pattern: /socket disconnected before (secure TLS|TLS) connection/i,
    cliVersion: 'node (observed 2026-10-16)',
    classify: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
    userMessage: NETWORK_TRANSIENT_USER_MESSAGE,
  },
  {
    pattern: /\bECONNRESET\b/,
    cliVersion: 'node (observed 2026-10-16)',
    classify: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
    userMessage: NETWORK_TRANSIENT_USER_MESSAGE,
  },
  {
    pattern: /\bEPROTO\b|ERR_SSL_/,
    cliVersion: 'node (observed 2026-10-16)',
    classify: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
    userMessage: NETWORK_TRANSIENT_USER_MESSAGE,
  },
]);

export function matchCliSignature(
  stderrTail: string | undefined,
  signatures: readonly CliSignature[] | undefined,
): CliSignature | undefined {
  if (!stderrTail || !signatures?.length) return undefined;
  for (const signature of signatures) {
    if (signature.pattern.test(stderrTail)) return signature;
  }
  return undefined;
}

export function cardUserMessage(
  outcome: { kind: string; cause?: string },
  signature: CliSignature | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled) return undefined;
  if (outcome.kind === 'partial') return signature?.userMessage;
  if (outcome.kind !== 'failed') return undefined;
  return signature?.userMessage ?? UNCLASSIFIED_USER_MESSAGE;
}

export function noteUnclassifiedStderr(input: {
  outcome: { kind: string; cause?: string };
  stderrTail?: string;
  signature?: CliSignature;
  agent?: string;
}): void {
  if (input.outcome.kind !== 'failed' || input.outcome.cause !== 'unclassified') return;
  if (!input.stderrTail || input.signature) return;
  const agent = input.agent ?? 'unknown';
  log.info('run', 'stderr-unclassified', { agent, count: 1 });
  reportMetric('stderr_unclassified', 1, { agent });
}
