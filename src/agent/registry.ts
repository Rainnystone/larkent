import { ClaudeJsonlTranslator } from './claude/stream-json';
import {
  claudeAgentOptionsSchema,
  claudePolicyInputs,
  mapClaudeEffectiveAccess,
} from './claude/options';
import { CodexJsonlTranslator } from './codex/jsonl';
import {
  codexAgentOptionsSchema,
  codexPolicyInputs,
  mapCodexEffectiveAccess,
} from './codex/options';
import { CursorJsonlTranslator } from './cursor/jsonl';
import {
  cursorAgentOptionsSchema,
  cursorPolicyInputs,
  mapCursorEffectiveAccess,
} from './cursor/options';
import { GrokJsonlTranslator } from './grok/jsonl';
import {
  grokAgentOptionsSchema,
  grokPolicyInputs,
  mapGrokEffectiveAccess,
} from './grok/options';
import { KimiJsonlTranslator } from './kimi/jsonl';
import {
  kimiAgentOptionsSchema,
  kimiPolicyInputs,
  mapKimiEffectiveAccess,
} from './kimi/options';
import type { JsonlTranslator } from './runner/jsonl-translator';
import type { AgentOptionsSchema, EffectiveAccess } from './types';

export type { JsonlTranslator } from './runner/jsonl-translator';

export const AGENT_KINDS = ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentReplyMode = 'stream-deltas' | 'final-answer';
export type AgentResumeHistory = 'claude-native' | 'codex-thread' | 'catalog-session';
export type AgentAccessStatusKind =
  | 'claude-permission'
  | 'codex-sandbox'
  | 'kimi-auto'
  | 'grok-bypass'
  | 'cursor-force';

export interface AgentModelOption {
  readonly value: string;
  readonly label: string;
}

export interface AgentCapabilityTemplate {
  readonly agentId: AgentKind;
  readonly sessionKind:
    | 'claude-session'
    | 'codex-thread'
    | 'kimi-session'
    | 'grok-session'
    | 'cursor-session';
  readonly promptInjection: 'append-system-prompt' | 'stdin-prefix' | 'argv-prefix';
  readonly supportsNativeHistory: boolean;
  readonly callback: {
    readonly marker: string;
    readonly legacyMarkers: readonly string[];
  };
}

export interface AgentDescriptor {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly binaryNames: readonly string[];
  readonly envBinVar: string;
  readonly capabilities: AgentCapabilityTemplate;
  readonly models: readonly AgentModelOption[];
  readonly replyMode: AgentReplyMode;
  readonly resume: { readonly flag: string; readonly label: string };
  readonly resumeHistory: AgentResumeHistory;
  readonly resumeNoun: string;
  readonly accessStatusKind: AgentAccessStatusKind;
  readonly createRequiresInstalled: boolean;
  readonly missingBinaryMessage: string;
  readonly missingBinaryHint: string;
  readonly requiresCodexConfig: boolean;
  readonly detectionOrder: number;
  readonly upgradeWorkspacePermissionsToFull: boolean;
  readonly inheritCodexHomeWhenIsolated: boolean;
  readonly createTranslator: () => JsonlTranslator;
  readonly agentOptionsSchema: AgentOptionsSchema;
  readonly policyInputs: (options: unknown) => Record<string, unknown>;
  readonly mapEffectiveAccess: (access: EffectiveAccess) => unknown;
}

const DEFAULT_MODEL_OPTION: AgentModelOption = {
  value: 'default',
  label: '跟随默认（不指定）',
};

const CLAUDE: AgentDescriptor = {
  kind: 'claude',
  displayName: 'Claude Code',
  binaryNames: ['claude'],
  envBinVar: 'LARK_CHANNEL_CLAUDE_BIN',
  capabilities: {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: ['__claude_cb'] },
  },
  models: [
    DEFAULT_MODEL_OPTION,
    { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
    { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
  ],
  replyMode: 'stream-deltas',
  resume: { flag: '--resume', label: 'session' },
  resumeHistory: 'claude-native',
  resumeNoun: 'Claude',
  accessStatusKind: 'claude-permission',
  createRequiresInstalled: false,
  missingBinaryMessage: '',
  missingBinaryHint: '',
  requiresCodexConfig: false,
  detectionOrder: 1,
  upgradeWorkspacePermissionsToFull: true,
  inheritCodexHomeWhenIsolated: false,
  createTranslator: () => new ClaudeJsonlTranslator(),
  agentOptionsSchema: claudeAgentOptionsSchema,
  policyInputs: claudePolicyInputs,
  mapEffectiveAccess: mapClaudeEffectiveAccess,
};

const CODEX: AgentDescriptor = {
  kind: 'codex',
  displayName: 'Codex CLI',
  binaryNames: ['codex'],
  envBinVar: 'LARK_CHANNEL_CODEX_BIN',
  capabilities: {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  },
  models: [
    DEFAULT_MODEL_OPTION,
    { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'o3', label: 'o3' },
  ],
  replyMode: 'final-answer',
  resume: { flag: 'resume', label: 'thread' },
  resumeHistory: 'codex-thread',
  resumeNoun: 'Codex',
  accessStatusKind: 'codex-sandbox',
  createRequiresInstalled: false,
  missingBinaryMessage: '',
  missingBinaryHint: '',
  requiresCodexConfig: true,
  detectionOrder: 2,
  upgradeWorkspacePermissionsToFull: false,
  inheritCodexHomeWhenIsolated: true,
  createTranslator: () => new CodexJsonlTranslator(),
  agentOptionsSchema: codexAgentOptionsSchema,
  policyInputs: codexPolicyInputs,
  mapEffectiveAccess: mapCodexEffectiveAccess,
};

const KIMI: AgentDescriptor = {
  kind: 'kimi',
  displayName: 'Kimi Code',
  binaryNames: ['kimi'],
  envBinVar: 'LARK_CHANNEL_KIMI_BIN',
  capabilities: {
    agentId: 'kimi',
    sessionKind: 'kimi-session',
    promptInjection: 'argv-prefix',
    supportsNativeHistory: false,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  },
  models: [
    DEFAULT_MODEL_OPTION,
    { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
  ],
  replyMode: 'final-answer',
  resume: { flag: '-S', label: 'session' },
  resumeHistory: 'catalog-session',
  resumeNoun: 'Kimi',
  accessStatusKind: 'kimi-auto',
  createRequiresInstalled: false,
  missingBinaryMessage: '',
  missingBinaryHint: '',
  requiresCodexConfig: false,
  detectionOrder: 3,
  upgradeWorkspacePermissionsToFull: false,
  inheritCodexHomeWhenIsolated: false,
  createTranslator: () => new KimiJsonlTranslator(),
  agentOptionsSchema: kimiAgentOptionsSchema,
  policyInputs: kimiPolicyInputs,
  mapEffectiveAccess: mapKimiEffectiveAccess,
};

const GROK: AgentDescriptor = {
  kind: 'grok',
  displayName: 'Grok Build',
  binaryNames: ['grok'],
  envBinVar: 'LARK_CHANNEL_GROK_BIN',
  capabilities: {
    agentId: 'grok',
    sessionKind: 'grok-session',
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  },
  models: [
    DEFAULT_MODEL_OPTION,
    { value: 'grok-build', label: 'Grok Build' },
    { value: 'grok-4.6', label: 'Grok 4.6' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
  ],
  replyMode: 'final-answer',
  resume: { flag: '-r', label: 'session' },
  resumeHistory: 'catalog-session',
  resumeNoun: 'Grok',
  accessStatusKind: 'grok-bypass',
  createRequiresInstalled: true,
  missingBinaryMessage:
    '未检测到 Grok Build CLI（grok）。请先安装并登录后再创建 grok profile。',
  missingBinaryHint: '未检测到 Grok Build CLI（grok）。请先安装并登录。',
  requiresCodexConfig: false,
  detectionOrder: 0,
  upgradeWorkspacePermissionsToFull: false,
  inheritCodexHomeWhenIsolated: false,
  createTranslator: () => new GrokJsonlTranslator(),
  agentOptionsSchema: grokAgentOptionsSchema,
  policyInputs: grokPolicyInputs,
  mapEffectiveAccess: mapGrokEffectiveAccess,
};

const CURSOR_BINARY_NAMES = ['cursor-agent', 'agent'] as const;

const CURSOR: AgentDescriptor = {
  kind: 'cursor',
  displayName: 'Cursor CLI',
  binaryNames: CURSOR_BINARY_NAMES,
  envBinVar: 'LARK_CHANNEL_CURSOR_BIN',
  capabilities: {
    agentId: 'cursor',
    sessionKind: 'cursor-session',
    promptInjection: 'argv-prefix',
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  },
  models: [
    DEFAULT_MODEL_OPTION,
    { value: 'composer-2.5', label: 'Composer 2.5' },
    { value: 'grok-4.6', label: 'Grok 4.6' },
  ],
  replyMode: 'final-answer',
  resume: { flag: '--resume', label: 'session' },
  resumeHistory: 'catalog-session',
  resumeNoun: 'Cursor',
  accessStatusKind: 'cursor-force',
  createRequiresInstalled: true,
  missingBinaryMessage:
    '未检测到 Cursor CLI（cursor-agent / agent）。请先安装并登录后再创建 cursor profile。',
  missingBinaryHint: '未检测到 Cursor CLI（cursor-agent / agent）。请先安装并登录。',
  requiresCodexConfig: false,
  detectionOrder: 4,
  upgradeWorkspacePermissionsToFull: false,
  inheritCodexHomeWhenIsolated: false,
  createTranslator: () => new CursorJsonlTranslator(),
  agentOptionsSchema: cursorAgentOptionsSchema,
  policyInputs: cursorPolicyInputs,
  mapEffectiveAccess: mapCursorEffectiveAccess,
};

const DESCRIPTORS = {
  claude: CLAUDE,
  codex: CODEX,
  kimi: KIMI,
  grok: GROK,
  cursor: CURSOR,
} as const satisfies Record<AgentKind, AgentDescriptor>;

export const AGENT_REGISTRY: ReadonlyMap<AgentKind, AgentDescriptor> = new Map(
  AGENT_KINDS.map((kind) => [kind, DESCRIPTORS[kind]]),
);

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

export function unknownAgentKindMessage(value: unknown): string {
  return `unknown agent kind ${String(value)}; expected one of: ${AGENT_KINDS.join(', ')}`;
}

export function requireAgentKind(value: unknown): AgentKind {
  if (isAgentKind(value)) return value;
  throw new Error(unknownAgentKindMessage(value));
}

export function descriptorFor(kind: AgentKind): AgentDescriptor {
  const descriptor = AGENT_REGISTRY.get(kind);
  if (!descriptor) throw new Error(unknownAgentKindMessage(kind));
  return descriptor;
}

export function parseAgentKind(value: string | undefined): AgentKind | undefined {
  if (value === undefined || value === '') return undefined;
  return requireAgentKind(value);
}

export function agentKindHelpList(): string {
  return AGENT_KINDS.join(', ');
}

export function agentKindCliUnion(): string {
  return AGENT_KINDS.join('|');
}

export function kindsInDetectionOrder(): AgentKind[] {
  return [...AGENT_KINDS].sort(
    (a, b) => descriptorFor(a).detectionOrder - descriptorFor(b).detectionOrder,
  );
}
