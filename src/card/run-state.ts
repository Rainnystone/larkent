import type { AgentEvent } from '../agent/types';
import { bridgeToolLabel } from './bridge-tool-call';
import {
  confirmDirectImSend,
  rememberDirectImSend,
  type DirectImSendTarget,
} from './direct-im-send';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
  /** Friendly progress-card label when this is an internal bridge-tool call. */
  bridgeLabel?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean; notice?: true }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout' | 'runner_timeout';

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /**
   * Chat ids the agent successfully IM-sent to during this in-memory run.
   * Never persisted. Detection is in the shared reducer (not a post-run
   * history check by bot identity).
   */
  directImSentChatIds: ReadonlySet<string>;
  pendingDirectImSends: ReadonlyMap<string, DirectImSendTarget>;
  currentChatId?: string;
  batchMessageIds?: ReadonlySet<string>;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
  directImSentChatIds: new Set(),
  pendingDirectImSends: new Map(),
};

export function seedRunState(input: {
  currentChatId?: string;
  batchMessageIds?: readonly string[];
}): RunState {
  return {
    ...initialState,
    directImSentChatIds: new Set(),
    pendingDirectImSends: new Map(),
    ...(input.currentChatId ? { currentChatId: input.currentChatId } : {}),
    ...(input.batchMessageIds && input.batchMessageIds.length > 0
      ? { batchMessageIds: new Set(input.batchMessageIds) }
      : {}),
  };
}

export function shouldSkipFinalReply(
  state: RunState,
  chatId: string,
  extraSentChatIds?: ReadonlySet<string>,
): boolean {
  if (state.terminal !== 'done') return false;
  return state.directImSentChatIds.has(chatId) || extraSentChatIds?.has(chatId) === true;
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'final_text':
      return { ...state, finalText: evt.content };

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const bridgeLabel = bridgeToolLabel(evt.input);
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
        ...(bridgeLabel ? { bridgeLabel } : {}),
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
        pendingDirectImSends: rememberDirectImSend(state, evt.id, evt.input),
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError || hasNonzeroShellExit(b.tool.name, evt.output) ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks, ...confirmDirectImSend(state, evt.id, evt.output, evt.isError) };
    }

    case 'error': {
      const terminal = terminalFromReason(evt.terminationReason, 'error');
      return {
        ...state,
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'done': {
      const terminal = terminalFromReason(evt.terminationReason, 'done');
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

/** Some runtimes report completion separately from the shell's numeric exit. */
function hasNonzeroShellExit(name: string, output: string): boolean {
  if (!['bash', 'shell', 'command_execution', 'run_terminal_cmd'].includes(name.toLowerCase())) return false;
  try {
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const rec = result as Record<string, unknown>;
    return [rec.exitCode, rec.exit_code].some(code => typeof code === 'number' && Number.isInteger(code) && code !== 0);
  } catch {
    return false;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function markRunnerTimeout(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'runner_timeout',
    footer: null,
  };
}

function terminalFromReason(
  reason: 'normal' | 'interrupted' | 'timeout' | 'failed',
  fallback: 'done' | 'error',
): Terminal {
  switch (reason) {
    case 'interrupted':
      return 'interrupted';
    case 'timeout':
      return 'runner_timeout';
    case 'normal':
    case 'failed':
      return fallback;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** User-visible note for a terminal card / markdown footer. */
export function terminalNote(state: RunState): string | undefined {
  switch (state.terminal) {
    case 'interrupted':
      return '_⏹ 已被中断_';
    case 'idle_timeout':
      return `_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应,已自动终止_`;
    case 'runner_timeout':
      return '_⏱ 运行超时,已自动终止_';
    case 'error':
      return state.errorMsg ? `⚠️ agent 失败：${state.errorMsg}` : undefined;
    case 'done':
    case 'running':
      return undefined;
    default: {
      const _exhaustive: never = state.terminal;
      return _exhaustive;
    }
  }
}

export function terminalSummary(state: RunState): string {
  switch (state.terminal) {
    case 'interrupted':
      return '已中断';
    case 'idle_timeout':
      return '已超时';
    case 'runner_timeout':
      return '运行超时';
    case 'error':
      return '出错';
    case 'done':
      return '已完成';
    case 'running':
      if (state.footer === 'tool_running') return '正在调用工具';
      if (state.footer === 'streaming') return '正在输出';
      return '思考中';
    default: {
      const _exhaustive: never = state.terminal;
      return _exhaustive;
    }
  }
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}
