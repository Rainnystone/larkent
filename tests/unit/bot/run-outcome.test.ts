import { describe, expect, it } from 'vitest';
import {
  cardTerminalFromOutcome,
  deriveRunOutcome,
  formatRunOutcome,
  formatStopRequest,
  noteTerminalStop,
  requestStop,
  shouldDeliverAgentEvent,
  type CliSignature,
  type RunOutcome,
  type StoppableHandle,
  type StopRequest,
} from '../../../src/bot/run-outcome';

const STOP_REQUESTS = [
  { type: 'user-stop' },
  { type: 'superseded', by: 'new' },
  { type: 'superseded', by: 'cd' },
  { type: 'superseded', by: 'ws' },
  { type: 'superseded', by: 'resume' },
  { type: 'reconnect-command' },
  { type: 'keepalive-restart' },
  { type: 'account-restart' },
  { type: 'shutdown-signal' },
  { type: 'exit-command' },
  { type: 'bridge-idle-watchdog' },
  { type: 'runner-timeout' },
  { type: 'meeting' },
  { type: 'subscriber-abandoned' },
  { type: 'external-signal' },
] as const satisfies readonly StopRequest[];

describe('deriveRunOutcome', () => {
  it.each([
    {
      name: 'completed on done(normal) even with a stop request',
      input: {
        stopRequest: { type: 'user-stop' } as const,
        terminalEvent: { type: 'done' as const, terminationReason: 'normal' as const },
      },
      expected: { kind: 'completed', retriable: false, needsHuman: false },
      terminal: 'done',
      formatted: 'completed',
    },
    {
      name: 'partial from a signature match even on exit 0',
      input: {
        exit: 0,
        stderrTail: '[agy] print timeout after 5m0s with turn in progress; returning partial output',
        signatures: [
          {
            pattern: /print timeout after .* returning partial output/,
            classify: { kind: 'partial', retriable: true, needsHuman: false },
          },
        ] satisfies CliSignature[],
      },
      expected: { kind: 'partial', retriable: true, needsHuman: false },
      terminal: 'done',
      formatted: 'partial',
    },
    {
      name: 'failed(auth-required) from a signature',
      input: {
        exit: 1,
        terminalEvent: { type: 'error' as const, message: 'auth', terminationReason: 'failed' as const },
        stderrTail: "Your stored authentication is invalid. Please run 'agent login'.",
        signatures: [
          {
            pattern: /stored authentication is invalid/i,
            classify: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
          },
        ] satisfies CliSignature[],
      },
      expected: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
      terminal: 'error',
      formatted: 'failed:auth-required',
    },
    {
      name: 'failed(transient-upstream) from a signature',
      input: {
        exit: 1,
        stderrTail: 'RetriableError: Connection stalled repeatedly',
        signatures: [
          {
            pattern: /Connection stalled repeatedly/,
            classify: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
          },
        ] satisfies CliSignature[],
      },
      expected: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
      terminal: 'error',
      formatted: 'failed:transient-upstream',
    },
    {
      name: 'failed(quota) from a signature',
      input: {
        exit: 1,
        stderrTail: 'rate limit exceeded for this API key',
        signatures: [
          {
            pattern: /rate limit exceeded/i,
            classify: { kind: 'failed', cause: 'quota', retriable: false, needsHuman: true },
          },
        ] satisfies CliSignature[],
      },
      expected: { kind: 'failed', cause: 'quota', retriable: false, needsHuman: true },
      terminal: 'error',
      formatted: 'failed:quota',
    },
    {
      name: 'failed(killed-externally) on SIGKILL without a stop request',
      input: { signal: 'SIGKILL', exit: null },
      expected: { kind: 'failed', cause: 'killed-externally', retriable: true, needsHuman: false },
      terminal: 'error',
      formatted: 'failed:killed-externally',
    },
    {
      name: 'failed(unclassified) on nonzero exit without signatures',
      input: {
        exit: 1,
        terminalEvent: { type: 'error' as const, message: 'boom', terminationReason: 'failed' as const },
      },
      expected: { kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: false },
      terminal: 'error',
      formatted: 'failed:unclassified',
    },
    {
      name: 'real error terminal beats a stop request',
      input: {
        stopRequest: { type: 'user-stop' } as const,
        terminalEvent: { type: 'error' as const, message: 'boom', terminationReason: 'failed' as const },
        exit: 1,
      },
      expected: { kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: false },
      terminal: 'error',
      formatted: 'failed:unclassified',
    },
    {
      name: 'runner timeout terminal maps to interrupted(runner-timeout)',
      input: {
        terminalEvent: { type: 'error' as const, message: 'cursor timeout', terminationReason: 'timeout' as const },
      },
      expected: {
        kind: 'interrupted',
        reason: { type: 'runner-timeout' },
        retriable: true,
        needsHuman: false,
      },
      terminal: 'runner_timeout',
      formatted: 'interrupted:runner-timeout',
    },
    {
      name: 'timeout terminal beats an idle stop request',
      input: {
        stopRequest: { type: 'bridge-idle-watchdog' } as const,
        terminalEvent: { type: 'done' as const, terminationReason: 'timeout' as const },
      },
      expected: {
        kind: 'interrupted',
        reason: { type: 'runner-timeout' },
        retriable: true,
        needsHuman: false,
      },
      terminal: 'runner_timeout',
      formatted: 'interrupted:runner-timeout',
    },
    {
      name: 'no stop request plus signal exit is interrupted(external-signal)',
      input: { signal: 'SIGTERM', exit: null },
      expected: {
        kind: 'interrupted',
        reason: { type: 'external-signal' },
        retriable: true,
        needsHuman: false,
      },
      terminal: 'interrupted',
      formatted: 'interrupted:external-signal',
    },
    {
      name: 'interrupted terminal without a stop request is external-signal',
      input: {
        terminalEvent: { type: 'done' as const, terminationReason: 'interrupted' as const },
        signal: 'SIGTERM',
      },
      expected: {
        kind: 'interrupted',
        reason: { type: 'external-signal' },
        retriable: true,
        needsHuman: false,
      },
      terminal: 'interrupted',
      formatted: 'interrupted:external-signal',
    },
    {
      name: 'empty input completes',
      input: {},
      expected: { kind: 'completed', retriable: false, needsHuman: false },
      terminal: 'done',
      formatted: 'completed',
    },
  ] as const)('$name', ({ input, expected, terminal, formatted }) => {
    const outcome = deriveRunOutcome(input);
    expect(outcome).toEqual(expected);
    expect(cardTerminalFromOutcome(outcome)).toBe(terminal);
    expect(formatRunOutcome(outcome)).toBe(formatted);
  });

  it.each(STOP_REQUESTS)('stop request %j without a terminal is interrupted(reason)', (stopRequest) => {
    const outcome = deriveRunOutcome({ stopRequest });
    const expected: RunOutcome = {
      kind: 'interrupted',
      reason: stopRequest,
      retriable: interruptedRetriable(stopRequest),
      needsHuman: false,
    };
    expect(outcome).toEqual(expected);
    expect(formatRunOutcome(outcome)).toBe(`interrupted:${formatStopRequest(stopRequest)}`);
  });
});

describe('shouldDeliverAgentEvent', () => {
  it('still delivers a terminal event after stop when runOutcome is on', () => {
    const handle = { interrupted: true, stopRequest: { type: 'user-stop' as const } };
    expect(shouldDeliverAgentEvent(handle, { type: 'done', terminationReason: 'normal' }, true)).toBe(true);
    expect(shouldDeliverAgentEvent(handle, { type: 'text', delta: 'x' }, true)).toBe(false);
    expect(shouldDeliverAgentEvent(handle, { type: 'done', terminationReason: 'normal' }, false)).toBe(false);
    expect(shouldDeliverAgentEvent(handle, { type: 'system' }, false)).toBe(true);
  });
});

describe('requestStop first-writer-wins', () => {
  it('keeps the first reason and still marks interrupted', () => {
    const handle = { interrupted: false };
    expect(requestStop(handle, { type: 'user-stop' })).toBe(true);
    expect(requestStop(handle, { type: 'shutdown-signal' })).toBe(false);
    expect(handle).toEqual({
      interrupted: true,
      stopRequest: { type: 'user-stop' },
    });
  });

  it('notes timeout and interrupted terminals without overwriting an earlier reason', () => {
    const timeout: StoppableHandle = { interrupted: false };
    expect(noteTerminalStop(timeout, { type: 'error', message: 't', terminationReason: 'timeout' })).toBe(true);
    expect(timeout.stopRequest).toEqual({ type: 'runner-timeout' });
    const prior = { interrupted: true, stopRequest: { type: 'user-stop' as const } };
    expect(noteTerminalStop(prior, { type: 'done', terminationReason: 'interrupted' })).toBe(false);
    expect(prior.stopRequest).toEqual({ type: 'user-stop' });
    expect(noteTerminalStop({ interrupted: false }, { type: 'text', delta: 'x' })).toBe(false);
  });
});

describe('stop request formatting', () => {
  it('covers every stop request variant', () => {
    const seen = new Set(STOP_REQUESTS.map((reason) => formatStopRequest(reason)));
    expect(seen).toEqual(new Set([
      'user-stop',
      'superseded:new',
      'superseded:cd',
      'superseded:ws',
      'superseded:resume',
      'reconnect-command',
      'keepalive-restart',
      'account-restart',
      'shutdown-signal',
      'exit-command',
      'bridge-idle-watchdog',
      'runner-timeout',
      'meeting',
      'subscriber-abandoned',
      'external-signal',
    ]));
  });
});

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
