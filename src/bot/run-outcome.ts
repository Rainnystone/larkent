import { matchCliSignature, type CliSignature } from '../agent/cli-signatures';
import type { AgentEvent } from '../agent/types';
import type { Terminal } from '../card/run-state';

export type { CliSignature };

export type SupersedeBy = 'new' | 'cd' | 'ws' | 'resume';

export type StopRequest =
  | { type: 'user-stop' }
  | { type: 'superseded'; by: SupersedeBy }
  | { type: 'reconnect-command' }
  | { type: 'account-restart' }
  | { type: 'shutdown-signal' }
  | { type: 'exit-command' }
  | { type: 'bridge-idle-watchdog' }
  | { type: 'runner-timeout' }
  | { type: 'meeting' }
  | { type: 'subscriber-abandoned' }
  | { type: 'external-signal' }
  | { type: 'policy-guard'; code?: 'auth-config' };

export type FailedCause =
  | 'transient-upstream'
  | 'auth-required'
  | 'quota'
  | 'killed-externally'
  | 'unclassified';

export type RunOutcome =
  | { kind: 'completed'; retriable: boolean; needsHuman: boolean }
  | { kind: 'partial'; retriable: boolean; needsHuman: boolean }
  | { kind: 'interrupted'; reason: StopRequest; retriable: boolean; needsHuman: boolean }
  | { kind: 'failed'; cause: FailedCause; retriable: boolean; needsHuman: boolean };

export interface DeriveRunOutcomeInput {
  stopRequest?: StopRequest;
  exit?: number | null;
  signal?: NodeJS.Signals | string | null;
  terminalEvent?: AgentEvent;
  stderrTail?: string;
  signatures?: readonly CliSignature[];
  /** True when the Feishu link's outage epoch changed during the run. */
  outageOverlapped?: boolean;
}

export interface StoppableHandle {
  interrupted: boolean;
  stopRequest?: StopRequest;
}

/** First writer wins. Sets `interrupted` whenever a reason is recorded. */
export function requestStop(handle: StoppableHandle, reason: StopRequest): boolean {
  if (handle.stopRequest) return false;
  handle.stopRequest = reason;
  handle.interrupted = true;
  return true;
}

/** Implied stop reason for a terminal event, if that event itself is a stop. */
export function stopRequestFromTerminal(event: AgentEvent): StopRequest | undefined {
  if (event.type !== 'done' && event.type !== 'error') return undefined;
  const reason = event.terminationReason;
  switch (reason) {
    case 'timeout':
      return { type: 'runner-timeout' };
    case 'interrupted':
      return { type: 'external-signal' };
    case 'normal':
    case 'failed':
      return undefined;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Record a terminal event's implied stop reason. First writer still wins. */
export function noteTerminalStop(handle: StoppableHandle, event: AgentEvent): boolean {
  const reason = stopRequestFromTerminal(event);
  return reason ? requestStop(handle, reason) : false;
}

/**
 * System events always pass. A real terminal still lands after stop.
 * `final_text` also passes: Grok holds the answer until `finish('interrupted')`,
 * so dropping it throws away the only copy. Claude and Codex already streamed
 * their answer as `text` deltas; those stay suppressed so a stop does not post
 * the same words again.
 */
export function shouldDeliverAgentEvent(
  handle: StoppableHandle,
  event: AgentEvent,
): boolean {
  if (event.type === 'system') return true;
  if (!handle.interrupted) return true;
  if (event.type === 'final_text') return true;
  return event.type === 'done' || event.type === 'error';
}

export function deriveRunOutcome(input: DeriveRunOutcomeInput): RunOutcome {
  return applyOutageOverlap(deriveRunOutcomeShape(input), input);
}

export function runOverlappedOutage(
  link: { outageEpoch(): number } | undefined,
  startedEpoch: number,
  startedDown = false,
): boolean {
  if (!link) return false;
  if (startedDown) return true;
  return link.outageEpoch() !== startedEpoch;
}

function deriveRunOutcomeShape(input: DeriveRunOutcomeInput): RunOutcome {
  const signed = matchCliSignature(input.stderrTail, input.signatures);
  if (signed && signatureApplies(signed.classify, input)) {
    return applySignatureOverlay(signed.classify);
  }
  // agy prints `error: interrupted` and exits 1 on SIGTERM, which the runner
  // surfaces as a failed terminal. Keep an earlier user-stop (or other stop)
  // instead of letting that failed exit become unclassified.
  if (signed?.classify.kind === 'interrupted' && input.stopRequest) {
    return interrupted(input.stopRequest);
  }

  const terminal = input.terminalEvent;
  if (terminal?.type === 'done' && terminal.terminationReason === 'normal') {
    return completed();
  }
  if (
    (terminal?.type === 'done' || terminal?.type === 'error')
    && terminal.terminationReason === 'timeout'
  ) {
    return interrupted({ type: 'runner-timeout' });
  }
  if (terminal?.type === 'error' && terminal.terminationReason === 'failed') {
    return failed(signalCause(input.signal) ?? 'unclassified');
  }
  if (
    (terminal?.type === 'done' || terminal?.type === 'error')
    && terminal.terminationReason === 'interrupted'
  ) {
    return interrupted(input.stopRequest ?? { type: 'external-signal' });
  }

  if (input.stopRequest) return interrupted(input.stopRequest);
  if (isKillSignal(input.signal)) return failed('killed-externally');
  if (input.signal) return interrupted({ type: 'external-signal' });
  if (input.exit !== undefined && input.exit !== null && input.exit !== 0) {
    return failed('unclassified');
  }
  return completed();
}

/** Signatures pick card wording and `needsHuman`; retriable follows the cause. */
function applySignatureOverlay(classify: RunOutcome): RunOutcome {
  if (classify.kind !== 'failed') return classify;
  if (classify.needsHuman) {
    return { ...classify, retriable: false };
  }
  return failed(classify.cause);
}

function applyOutageOverlap(outcome: RunOutcome, input: DeriveRunOutcomeInput): RunOutcome {
  if (outcome.kind !== 'failed') return outcome;
  if (outcome.needsHuman) return outcome;
  if (outcome.cause !== 'unclassified') return outcome;
  if (input.outageOverlapped) return failed('transient-upstream');
  return failed('unclassified');
}

function signatureApplies(
  classify: RunOutcome,
  input: DeriveRunOutcomeInput,
): boolean {
  if (!input.stopRequest) return true;
  switch (classify.kind) {
    case 'failed':
      return (
        input.terminalEvent?.type === 'error'
        && input.terminalEvent.terminationReason === 'failed'
      );
    case 'partial':
      return (
        input.terminalEvent?.type === 'done'
        && input.terminalEvent.terminationReason === 'normal'
      );
    case 'completed':
    case 'interrupted':
      return false;
    default: {
      const _exhaustive: never = classify;
      return _exhaustive;
    }
  }
}

function completed(): RunOutcome {
  return { kind: 'completed', retriable: false, needsHuman: false };
}

function interrupted(reason: StopRequest): RunOutcome {
  return {
    kind: 'interrupted',
    reason,
    retriable: interruptedRetriable(reason),
    needsHuman: false,
  };
}

function failed(cause: FailedCause): RunOutcome {
  switch (cause) {
    case 'transient-upstream':
      return { kind: 'failed', cause, retriable: true, needsHuman: false };
    case 'auth-required':
      return { kind: 'failed', cause, retriable: false, needsHuman: true };
    case 'quota':
      return { kind: 'failed', cause, retriable: false, needsHuman: true };
    case 'killed-externally':
      return { kind: 'failed', cause, retriable: true, needsHuman: false };
    case 'unclassified':
      return { kind: 'failed', cause, retriable: true, needsHuman: false };
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

function interruptedRetriable(reason: StopRequest): boolean {
  switch (reason.type) {
    case 'user-stop':
    case 'superseded':
    case 'exit-command':
    case 'account-restart':
      return false;
    case 'reconnect-command':
    case 'shutdown-signal':
    case 'bridge-idle-watchdog':
    case 'runner-timeout':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
      return true;
    case 'policy-guard':
      return false;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function signalCause(signal: DeriveRunOutcomeInput['signal']): FailedCause | undefined {
  return isKillSignal(signal) ? 'killed-externally' : undefined;
}

function isKillSignal(signal: DeriveRunOutcomeInput['signal']): boolean {
  return signal === 'SIGKILL';
}

export function formatStopRequest(reason: StopRequest): string {
  switch (reason.type) {
    case 'superseded':
      return `superseded:${reason.by}`;
    case 'user-stop':
    case 'reconnect-command':
    case 'account-restart':
    case 'shutdown-signal':
    case 'exit-command':
    case 'bridge-idle-watchdog':
    case 'runner-timeout':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
    case 'policy-guard':
      return reason.type;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function formatRunOutcome(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'interrupted':
      return `interrupted:${formatStopRequest(outcome.reason)}`;
    case 'failed':
      return `failed:${outcome.cause}`;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** User-facing Chinese reason. Logs keep {@link formatRunOutcome}. */
export function describeRunOutcome(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'completed':
      return '已完成';
    case 'partial':
      return '输出不完整';
    case 'interrupted':
      return describeStopRequest(outcome.reason);
    case 'failed':
      return describeFailedCause(outcome.cause);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function describeStopRequest(reason: StopRequest): string {
  switch (reason.type) {
    case 'user-stop':
      return '用户停止';
    case 'superseded':
      return '会话已切换';
    case 'reconnect-command':
      return '重连';
    case 'account-restart':
      return '账号切换';
    case 'shutdown-signal':
      return '进程退出';
    case 'exit-command':
      return '退出命令';
    case 'bridge-idle-watchdog':
      return '空闲超时';
    case 'runner-timeout':
      return '运行超时';
    case 'meeting':
      return '会议占用';
    case 'subscriber-abandoned':
      return '订阅已结束';
    case 'external-signal':
      return '外部信号中断';
    case 'policy-guard':
      return '策略拦截';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describeFailedCause(cause: FailedCause): string {
  switch (cause) {
    case 'transient-upstream':
      return '上游网络中断';
    case 'auth-required':
      return '登录已失效';
    case 'quota':
      return '额度不足';
    case 'killed-externally':
      return '进程被外部终止';
    case 'unclassified':
      return '出错';
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

export function cardTerminalFromOutcome(outcome: RunOutcome): Terminal {
  switch (outcome.kind) {
    case 'completed':
    case 'partial':
      return 'done';
    case 'interrupted':
      return interruptedCardTerminal(outcome.reason);
    case 'failed':
      return 'error';
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function interruptedCardTerminal(reason: StopRequest): Terminal {
  switch (reason.type) {
    case 'bridge-idle-watchdog':
      return 'idle_timeout';
    case 'runner-timeout':
      return 'runner_timeout';
    case 'user-stop':
    case 'superseded':
    case 'reconnect-command':
    case 'account-restart':
    case 'shutdown-signal':
    case 'exit-command':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
    case 'policy-guard':
      return 'interrupted';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
