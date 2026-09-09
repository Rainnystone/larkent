import type { AgentAvailability } from './preflight';

export type EffectiveAccess = 'read-only' | 'workspace' | 'full';

export interface AgentOptionsSchema {
  readonly parse: (value: unknown) => unknown;
}

export type AgentEvent =
  | { type: 'system'; resumeHandle?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      resumeHandle?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  resumeHandle?: string;
  model?: string;
  images?: readonly string[];
  agentOptions?: unknown;
  sandbox?: string;
  permissionMode?: string;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export function asAgentOptionsObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} agent options must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

export function runAgentOptions(opts: AgentRunOptions): unknown {
  return opts.agentOptions !== undefined ? opts.agentOptions : opts;
}

export function mergeAgentOptions(...bags: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const bag of bags) {
    Object.assign(merged, asAgentOptionsObject(bag, 'agent'));
  }
  return merged;
}

export function omitEmptyAgentOptions(options: unknown): unknown | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return undefined;
  return Object.keys(options).length > 0 ? options : undefined;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Resolves only after process exit and adapter cleanup; rejects if settlement fails. */
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for process exit and adapter cleanup.
   * Resolves true only when both complete, false when the timer fires first;
   * cleanup failure rejects (caller usually falls back to stop() on timeout).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
