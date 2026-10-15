import type { AgentEvent } from '../agent/types';
import type { Terminal } from '../card/run-state';

export type SupersedeBy = 'new' | 'cd' | 'ws' | 'resume';

export type StopRequest =
  | { type: 'user-stop' }
  | { type: 'superseded'; by: SupersedeBy }
  | { type: 'reconnect-command' }
  | { type: 'keepalive-restart' }
  | { type: 'account-restart' }
  | { type: 'shutdown-signal' }
  | { type: 'exit-command' }
  | { type: 'bridge-idle-watchdog' }
  | { type: 'runner-timeout' }
  | { type: 'meeting' }
  | { type: 'subscriber-abandoned' }
  | { type: 'external-signal' };

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

export interface CliSignature {
  pattern: RegExp;
  classify: Extract<RunOutcome, { kind: 'partial' | 'failed' }>;
}

export interface DeriveRunOutcomeInput {
  stopRequest?: StopRequest;
  exit?: number | null;
  signal?: NodeJS.Signals | string | null;
  terminalEvent?: AgentEvent;
  stderrTail?: string;
  signatures?: readonly CliSignature[];
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

/** System events always pass. With runOutcome on, a real terminal still lands after stop. */
export function shouldDeliverAgentEvent(
  handle: StoppableHandle,
  event: AgentEvent,
  runOutcomeEnabled: boolean,
): boolean {
  if (event.type === 'system') return true;
  if (!handle.interrupted) return true;
  if (!runOutcomeEnabled) return false;
  return event.type === 'done' || event.type === 'error';
}

export function deriveRunOutcome(input: DeriveRunOutcomeInput): RunOutcome {
  const signed = matchSignature(input.stderrTail, input.signatures);
  if (signed) return signed;

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

function matchSignature(
  stderrTail: string | undefined,
  signatures: readonly CliSignature[] | undefined,
): RunOutcome | undefined {
  if (!stderrTail || !signatures?.length) return undefined;
  for (const signature of signatures) {
    if (signature.pattern.test(stderrTail)) return signature.classify;
  }
  return undefined;
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
      return { kind: 'failed', cause, retriable: false, needsHuman: false };
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
    case 'keepalive-restart':
    case 'shutdown-signal':
    case 'bridge-idle-watchdog':
    case 'runner-timeout':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
      return true;
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
    case 'keepalive-restart':
    case 'account-restart':
    case 'shutdown-signal':
    case 'exit-command':
    case 'bridge-idle-watchdog':
    case 'runner-timeout':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
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
    case 'keepalive-restart':
    case 'account-restart':
    case 'shutdown-signal':
    case 'exit-command':
    case 'meeting':
    case 'subscriber-abandoned':
    case 'external-signal':
      return 'interrupted';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
