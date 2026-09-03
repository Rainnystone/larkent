import { accessToClaudePermissionMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import {
  claudeCapability,
  codexCapability,
  cursorCapability,
  grokCapability,
  kimiCapability,
  type AgentCapability,
  type AgentSessionKind,
  type PromptInjectionMode,
} from './capability';
import type { ModelOption } from './models';

export const AGENT_KINDS = ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentReplyMode = 'stream-deltas' | 'final-answer';

export interface AgentDescriptor {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly binaryNames: readonly string[];
  readonly envBinVar: string;
  readonly models: readonly ModelOption[];
  readonly replyMode: AgentReplyMode;
  readonly resume: { readonly flag: string; readonly label: 'session' | 'thread' };
  readonly sessionKind: AgentSessionKind;
  readonly promptInjection: PromptInjectionMode;
  readonly supportsNativeHistory: boolean;
  readonly usesNativeSessionId: boolean;
  readonly requireInstalled: boolean;
  readonly missingInstallMessage: string;
  capability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability;
  runtimeAccess(profile: ProfileConfig): { label: string; value: string };
}

const FOLLOW_DEFAULT: ModelOption = { value: 'default', label: '跟随默认（不指定）' };

const DESCRIPTORS: Record<AgentKind, AgentDescriptor> = {
  claude: {
    kind: 'claude',
    displayName: 'Claude Code',
    binaryNames: ['claude'],
    envBinVar: 'LARK_CHANNEL_CLAUDE_BIN',
    models: [
      FOLLOW_DEFAULT,
      { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
      { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
    ],
    replyMode: 'stream-deltas',
    resume: { flag: '--resume', label: 'session' },
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    usesNativeSessionId: true,
    requireInstalled: false,
    missingInstallMessage: '未检测到 Claude Code CLI（claude）。请先安装并登录后再创建 claude profile。',
    capability: (profile) => claudeCapability(profile),
    runtimeAccess: (profile) => ({
      label: 'permission',
      value: accessToClaudePermissionMode(
        profile.permissions.defaultAccess,
        profile.permissions,
      ),
    }),
  },
  codex: {
    kind: 'codex',
    displayName: 'Codex CLI',
    binaryNames: ['codex'],
    envBinVar: 'LARK_CHANNEL_CODEX_BIN',
    models: [
      FOLLOW_DEFAULT,
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'o3', label: 'o3' },
    ],
    replyMode: 'final-answer',
    resume: { flag: 'resume', label: 'thread' },
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    usesNativeSessionId: false,
    requireInstalled: false,
    missingInstallMessage: '未检测到 Codex CLI（codex）。请先安装并登录后再创建 codex profile。',
    capability: (profile) => {
      if (!profile) {
        throw new Error('codex capability requires a profile');
      }
      return codexCapability(profile);
    },
    runtimeAccess: (profile) => ({
      label: 'sandbox',
      value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
    }),
  },
  kimi: {
    kind: 'kimi',
    displayName: 'Kimi Code',
    binaryNames: ['kimi'],
    envBinVar: 'LARK_CHANNEL_KIMI_BIN',
    models: [
      FOLLOW_DEFAULT,
      { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
    ],
    replyMode: 'final-answer',
    resume: { flag: '-S', label: 'session' },
    sessionKind: 'kimi-session',
    promptInjection: 'argv-prefix',
    supportsNativeHistory: false,
    usesNativeSessionId: true,
    requireInstalled: false,
    missingInstallMessage: '未检测到 Kimi Code CLI（kimi）。请先安装并登录后再创建 kimi profile。',
    capability: (profile) => kimiCapability(profile),
    runtimeAccess: () => ({ label: 'permission', value: 'auto (kimi -p)' }),
  },
  grok: {
    kind: 'grok',
    displayName: 'Grok Build',
    binaryNames: ['grok'],
    envBinVar: 'LARK_CHANNEL_GROK_BIN',
    models: [
      FOLLOW_DEFAULT,
      { value: 'grok-build', label: 'Grok Build' },
      { value: 'grok-4.6', label: 'Grok 4.6' },
      { value: 'grok-4.5', label: 'Grok 4.5' },
    ],
    replyMode: 'final-answer',
    resume: { flag: '-r', label: 'session' },
    sessionKind: 'grok-session',
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    usesNativeSessionId: true,
    requireInstalled: true,
    missingInstallMessage:
      '未检测到 Grok Build CLI（grok）。请先安装并登录后再创建 grok profile。',
    capability: (profile) => grokCapability(profile),
    runtimeAccess: () => ({
      label: 'permission',
      value: 'bypassPermissions (grok --always-approve)',
    }),
  },
  cursor: {
    kind: 'cursor',
    displayName: 'Cursor CLI',
    binaryNames: ['cursor-agent', 'agent'],
    envBinVar: 'LARK_CHANNEL_CURSOR_BIN',
    models: [
      FOLLOW_DEFAULT,
      { value: 'composer-2.5', label: 'Composer 2.5' },
      { value: 'grok-4.6', label: 'Grok 4.6' },
    ],
    replyMode: 'final-answer',
    resume: { flag: '--resume', label: 'session' },
    sessionKind: 'cursor-session',
    promptInjection: 'argv-prefix',
    supportsNativeHistory: true,
    usesNativeSessionId: true,
    requireInstalled: true,
    missingInstallMessage:
      '未检测到 Cursor CLI（cursor-agent / agent）。请先安装并登录后再创建 cursor profile。',
    capability: (profile) => cursorCapability(profile),
    runtimeAccess: () => ({ label: 'permission', value: 'force (cursor --force)' }),
  },
};

export const AGENT_REGISTRY: ReadonlyMap<AgentKind, AgentDescriptor> = new Map(
  AGENT_KINDS.map((kind) => [kind, DESCRIPTORS[kind]]),
);

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && Object.hasOwn(DESCRIPTORS, value);
}

export function unknownAgentKindMessage(value: unknown): string {
  return `unknown agent kind: ${String(value)}. supported: ${AGENT_KINDS.join(', ')}`;
}

export function descriptorFor(kind: AgentKind): AgentDescriptor {
  return DESCRIPTORS[kind];
}

export function requireAgentKind(value: unknown): AgentKind {
  if (isAgentKind(value)) return value;
  throw new Error(unknownAgentKindMessage(value));
}

export function agentKindChoices(): string {
  return AGENT_KINDS.join(', ');
}

export function agentKindFlagChoices(): string {
  return AGENT_KINDS.join('|');
}
