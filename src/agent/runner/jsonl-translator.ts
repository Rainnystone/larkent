import type { AgentEvent } from '../types';

export interface JsonlTranslator {
  translate(line: string): AgentEvent[];
  finish(): AgentEvent[];
  fail(error: unknown): AgentEvent[];
}

export interface JsonlPrepareResult {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export type JsonlAbortKind = 'stop' | 'abort' | 'timeout';

export class JsonlRunAborted extends Error {
  readonly causeKind: JsonlAbortKind;

  constructor(causeKind: JsonlAbortKind, message: string) {
    super(message);
    this.name = 'JsonlRunAborted';
    this.causeKind = causeKind;
  }
}

export type JsonlFailMode = 'stop' | 'error';

export interface JsonlFailDisposition {
  readonly mode: JsonlFailMode;
  readonly terminationReason: 'interrupted' | 'timeout' | 'failed';
  readonly message: string;
}

export function parseJsonlLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function jsonlErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function jsonlFailDisposition(error: unknown): JsonlFailDisposition {
  if (error instanceof JsonlRunAborted) {
    switch (error.causeKind) {
      case 'stop':
        return {
          mode: 'stop',
          terminationReason: 'interrupted',
          message: error.message,
        };
      case 'abort':
        return {
          mode: 'error',
          terminationReason: 'interrupted',
          message: error.message,
        };
      case 'timeout':
        return {
          mode: 'error',
          terminationReason: 'timeout',
          message: error.message,
        };
      default: {
        const exhaustive: never = error.causeKind;
        throw new Error(`unhandled jsonl abort kind: ${String(exhaustive)}`);
      }
    }
  }
  return {
    mode: 'error',
    terminationReason: 'failed',
    message: jsonlErrorMessage(error),
  };
}

export function truncateJsonlMessage(value: string, max = 4096): string {
  return value.length > max ? value.slice(0, max) : value;
}
