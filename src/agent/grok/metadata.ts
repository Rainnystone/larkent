import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import { grokAgentOptionsSchema, grokPolicyInputs, mapGrokEffectiveAccess } from './options';

export function grokCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'grok', 'grok-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'grok',
    sessionKind: 'grok-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: { maxAccess },
  };
}

export const grokMetadata = defineMetadata({
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
  requireInstalled: true,
  missingInstallMessage: '未检测到 Grok Build CLI（grok）。请先安装并登录后再创建 grok profile。',
  agentOptionsSchema: grokAgentOptionsSchema,
  policyInputs: grokPolicyInputs,
  mapEffectiveAccess: mapGrokEffectiveAccess,
  capability: (profile) => grokCapability(profile),
  runtimeAccess: () => ({
    label: 'permission',
    value: 'bypassPermissions (grok --always-approve)',
  }),
});
