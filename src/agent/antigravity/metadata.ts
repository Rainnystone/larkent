import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import {
  antigravityAgentOptionsSchema,
  antigravityPolicyInputs,
  mapAntigravityEffectiveAccess,
} from './options';

export function antigravityCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'antigravity', 'antigravity-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'antigravity',
    sessionKind: 'antigravity-session',
    promptInjection: 'argv-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: { maxAccess },
  };
}

export const antigravityMetadata = defineMetadata({
  kind: 'antigravity',
  displayName: 'Antigravity CLI',
  binaryNames: ['agy'],
  envBinVar: 'LARK_CHANNEL_ANTIGRAVITY_BIN',
  models: [
    FOLLOW_DEFAULT,
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { value: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
    { value: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
    { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
    { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
    { value: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)' },
    { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  replyMode: 'final-answer',
  resume: { flag: '--conversation', label: 'session' },
  sessionKind: 'antigravity-session',
  promptInjection: 'argv-prefix',
  supportsNativeHistory: true,
  requireInstalled: true,
  missingInstallMessage:
    '未检测到 Antigravity CLI（agy）。请先安装并登录后再创建 antigravity profile。',
  agentOptionsSchema: antigravityAgentOptionsSchema,
  policyInputs: antigravityPolicyInputs,
  mapEffectiveAccess: mapAntigravityEffectiveAccess,
  capability: (profile) => antigravityCapability(profile),
  runtimeAccess: () => ({
    label: 'permission',
    value: 'always-proceed (agy --dangerously-skip-permissions)',
  }),
});
