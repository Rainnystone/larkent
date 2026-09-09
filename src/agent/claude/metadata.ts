import { accessToClaudePermissionMode } from '../../config/permissions';
import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import {
  claudeAgentOptionsSchema,
  claudePolicyInputs,
  mapClaudeEffectiveAccess,
} from './options';

export function claudeCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'claude', 'claude-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: { maxAccess },
  };
}

export const claudeMetadata = defineMetadata({
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
  requireInstalled: false,
  missingInstallMessage: '未检测到 Claude Code CLI（claude）。请先安装并登录后再创建 claude profile。',
  agentOptionsSchema: claudeAgentOptionsSchema,
  policyInputs: claudePolicyInputs,
  mapEffectiveAccess: mapClaudeEffectiveAccess,
  capability: (profile) => claudeCapability(profile),
  runtimeAccess: (profile) => ({
    label: 'permission',
    value: accessToClaudePermissionMode(profile.permissions.defaultAccess, profile.permissions),
  }),
});
