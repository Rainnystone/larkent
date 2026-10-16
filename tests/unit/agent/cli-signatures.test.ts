import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registeredAgentDescriptors, descriptorFor, type AgentKind } from '../../../src/agent/registry';
import {
  deriveRunOutcome,
  formatRunOutcome,
  type CliSignature,
} from '../../../src/bot/run-outcome';
import * as logger from '../../../src/core/logger';
import {
  cardUserMessage,
  NETWORK_TRANSIENT_SIGNATURES,
  noteUnclassifiedStderr,
} from '../../../src/agent/cli-signatures';

const GOLDENS = join(process.cwd(), 'tests/fixtures/goldens/stderr');

function readGolden(kind: string, name: string): string {
  return readFileSync(join(GOLDENS, kind, name), 'utf8');
}

describe('CLI stderr signature table', () => {
  it('puts stderrSignatures on every adapter descriptor', () => {
    for (const descriptor of registeredAgentDescriptors) {
      expect(Array.isArray(descriptor.stderrSignatures), descriptor.kind).toBe(true);
    }
  });

  it.each([
    {
      kind: 'cursor' as const,
      file: 'connection-stalled.txt',
      exit: 1,
      formatted: 'failed:transient-upstream',
      expected: { kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false },
    },
    {
      kind: 'cursor' as const,
      file: 'auth-invalid.txt',
      exit: 1,
      formatted: 'failed:auth-required',
      expected: { kind: 'failed', cause: 'auth-required', retriable: false, needsHuman: true },
    },
    {
      kind: 'antigravity' as const,
      file: 'print-timeout.txt',
      exit: 0,
      formatted: 'partial',
      expected: { kind: 'partial', retriable: true, needsHuman: false },
    },
    {
      kind: 'antigravity' as const,
      file: 'error-interrupted.txt',
      exit: 1,
      formatted: 'interrupted:external-signal',
      expected: {
        kind: 'interrupted',
        reason: { type: 'external-signal' },
        retriable: true,
        needsHuman: false,
      },
    },
  ])('$kind $file → $formatted', ({ kind, file, exit, formatted, expected }) => {
    const stderrTail = readGolden(kind, file);
    const outcome = deriveRunOutcome({
      exit,
      stderrTail,
      signatures: descriptorFor(kind).stderrSignatures,
      ...(exit === 0
        ? { terminalEvent: { type: 'done' as const, terminationReason: 'normal' as const } }
        : { terminalEvent: { type: 'error' as const, message: 'fail', terminationReason: 'failed' as const } }),
    });
    expect(outcome).toEqual(expected);
    expect(formatRunOutcome(outcome)).toBe(formatted);
    expect(matchingSignature(descriptorFor(kind).stderrSignatures, stderrTail)?.synthetic).not.toBe(true);
  });

  it('classifies grok/kimi synthetic goldens and marks them synthetic-only', () => {
    const grokStderr = readGolden('grok', 'synthetic-unauthorized.txt');
    const kimiStderr = readGolden('kimi', 'synthetic-rate-limit.txt');
    const grok = matchingSignature(descriptorFor('grok').stderrSignatures, grokStderr);
    const kimi = matchingSignature(descriptorFor('kimi').stderrSignatures, kimiStderr);
    expect(grok?.synthetic).toBe(true);
    expect(kimi?.synthetic).toBe(true);
    expect(deriveRunOutcome({
      exit: 1,
      stderrTail: grokStderr,
      signatures: descriptorFor('grok').stderrSignatures,
    })).toMatchObject({ kind: 'failed', cause: 'auth-required', needsHuman: true });
    expect(deriveRunOutcome({
      exit: 1,
      stderrTail: kimiStderr,
      signatures: descriptorFor('kimi').stderrSignatures,
    })).toMatchObject({ kind: 'failed', cause: 'quota', needsHuman: true });
  });

  it('uses the signature userMessage for partial outcomes', () => {
    const signature = descriptorFor('antigravity').stderrSignatures.find((item) => (
      item.classify.kind === 'partial'
    ));
    expect(signature).toBeDefined();
    expect(cardUserMessage({ kind: 'partial' }, signature, true)).toBe(signature?.userMessage);
    expect(cardUserMessage({ kind: 'completed' }, signature, true)).toBeUndefined();
  });

  it('does not let an interrupted signature override an existing stop request', () => {
    const outcome = deriveRunOutcome({
      stopRequest: { type: 'user-stop' },
      exit: 1,
      stderrTail: readGolden('antigravity', 'error-interrupted.txt'),
      signatures: descriptorFor('antigravity').stderrSignatures,
      terminalEvent: { type: 'error', message: 'error: interrupted', terminationReason: 'interrupted' },
    });
    expect(outcome).toMatchObject({ kind: 'interrupted', reason: { type: 'user-stop' } });
  });

  it.each([
    'socket-tls-disconnect.txt',
    'econnreset.txt',
    'eproto.txt',
    'eai-again.txt',
    'enotfound.txt',
  ])('classifies network golden %s as transient-upstream', (file) => {
    const stderrTail = readGolden('network', file);
    const outcome = deriveRunOutcome({
      exit: 1,
      stderrTail,
      signatures: NETWORK_TRANSIENT_SIGNATURES,
      terminalEvent: { type: 'error', message: stderrTail, terminationReason: 'failed' },
    });
    expect(outcome).toEqual({
      kind: 'failed',
      cause: 'transient-upstream',
      retriable: true,
      needsHuman: false,
    });
    expect(formatRunOutcome(outcome)).toBe('failed:transient-upstream');
    expect(cardUserMessage(outcome, matchingSignature(NETWORK_TRANSIENT_SIGNATURES, stderrTail), true))
      .toBe('网络连接中断，可稍后继续');
  });

  it('maps agy stop-exit (error: interrupted, exit 1, failed terminal) to user-stop', () => {
    const outcome = deriveRunOutcome({
      stopRequest: { type: 'user-stop' },
      exit: 1,
      stderrTail: readGolden('antigravity', 'error-interrupted.txt'),
      signatures: descriptorFor('antigravity').stderrSignatures,
      terminalEvent: { type: 'error', message: 'error: interrupted', terminationReason: 'failed' },
    });
    expect(outcome).toEqual({
      kind: 'interrupted',
      reason: { type: 'user-stop' },
      retriable: false,
      needsHuman: false,
    });
    expect(formatRunOutcome(outcome)).toBe('interrupted:user-stop');
    expect(cardUserMessage(outcome, matchingSignature(
      descriptorFor('antigravity').stderrSignatures,
      readGolden('antigravity', 'error-interrupted.txt'),
    ), true)).toBeUndefined();
  });

  it('classifies unknown stderr as unclassified and records a count log', () => {
    const stderrTail = readGolden('cursor', 'unclassified-with-paths.txt');
    const signatures = descriptorFor('cursor').stderrSignatures;
    const outcome = deriveRunOutcome({
      exit: 1,
      stderrTail,
      signatures,
      terminalEvent: { type: 'error', message: stderrTail, terminationReason: 'failed' },
    });
    expect(outcome).toEqual({ kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: false });
    expect(matchingSignature(signatures, stderrTail)).toBeUndefined();

    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const metric = vi.spyOn(logger, 'reportMetric').mockImplementation(() => {});
    noteUnclassifiedStderr({
      outcome,
      stderrTail,
      signature: matchingSignature(signatures, stderrTail),
      agent: 'cursor',
    });
    expect(info).toHaveBeenCalledWith('run', 'stderr-unclassified', expect.objectContaining({
      agent: 'cursor',
      count: 1,
    }));
    expect(metric).toHaveBeenCalledWith('stderr_unclassified', 1, { agent: 'cursor' });
    info.mockRestore();
    metric.mockRestore();
  });

  it('covers every observed golden file with a descriptor signature except unclassified', () => {
    const observed: Array<{ kind: AgentKind; skip?: string[] }> = [
      { kind: 'cursor', skip: ['unclassified-with-paths.txt'] },
      { kind: 'antigravity' },
    ];
    for (const { kind, skip = [] } of observed) {
      const files = readdirSync(join(GOLDENS, kind)).filter((name) => name.endsWith('.txt') && !skip.includes(name));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(
          matchingSignature(descriptorFor(kind).stderrSignatures, readGolden(kind, file)),
          `${kind}/${file}`,
        ).toBeDefined();
      }
    }
  });
});

function matchingSignature(
  signatures: readonly CliSignature[] | undefined,
  stderr: string,
): CliSignature | undefined {
  return signatures?.find((signature) => signature.pattern.test(stderr));
}
