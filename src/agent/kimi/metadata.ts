import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import { kimiAgentOptionsSchema, kimiPolicyInputs, mapKimiEffectiveAccess } from './options';

export function kimiCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'kimi', 'kimi-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'kimi',
    sessionKind: 'kimi-session',
    promptInjection: 'argv-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: { maxAccess },
  };
}

export const kimiMetadata = defineMetadata({
  kind: 'kimi',
  displayName: 'Kimi Code',
  binaryNames: ['kimi'],
  envBinVar: 'LARK_CHANNEL_KIMI_BIN',
  models: [FOLLOW_DEFAULT, { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' }],
  replyMode: 'final-answer',
  resume: { flag: '-S', label: 'session' },
  sessionKind: 'kimi-session',
  promptInjection: 'argv-prefix',
  supportsNativeHistory: false,
  requireInstalled: false,
  missingInstallMessage: '未检测到 Kimi Code CLI（kimi）。请先安装并登录后再创建 kimi profile。',
  agentOptionsSchema: kimiAgentOptionsSchema,
  policyInputs: kimiPolicyInputs,
  mapEffectiveAccess: mapKimiEffectiveAccess,
  capability: (profile) => kimiCapability(profile),
  runtimeAccess: () => ({ label: 'permission', value: 'auto (kimi -p)' }),
});
