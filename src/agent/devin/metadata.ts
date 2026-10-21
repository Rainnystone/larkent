import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import { devinAgentOptionsSchema, devinPolicyInputs, mapDevinEffectiveAccess } from './options';

export function devinCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'devin', 'devin-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'devin',
    sessionKind: 'devin-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: { maxAccess },
  };
}

export const devinMetadata = defineMetadata({
  kind: 'devin',
  displayName: 'Devin CLI',
  binaryNames: ['devin'],
  envBinVar: 'LARK_CHANNEL_DEVIN_BIN',
  models: [
    FOLLOW_DEFAULT,
    { value: 'adaptive', label: 'Adaptive' },
    { value: 'swe-2-max', label: 'SWE-2 Max' },
    { value: 'swe-2-high', label: 'SWE-2 High' },
    { value: 'swe-1-6', label: 'SWE-1.6' },
    { value: 'opus', label: 'Claude Opus' },
    { value: 'sonnet', label: 'Claude Sonnet' },
  ],
  replyMode: 'final-answer',
  resume: { flag: '-r', label: 'session' },
  sessionKind: 'devin-session',
  promptInjection: 'stdin-prefix',
  supportsNativeHistory: true,
  requireInstalled: false,
  missingInstallMessage: '未检测到 Devin CLI（devin）。请先安装并运行 devin auth login 后再创建 devin profile。',
  agentOptionsSchema: devinAgentOptionsSchema,
  policyInputs: devinPolicyInputs,
  mapEffectiveAccess: mapDevinEffectiveAccess,
  capability: (profile) => devinCapability(profile),
  runtimeAccess: () => ({ label: 'permission', value: 'Devin ACP session mode (ask→bypass; sandbox: plan/autonomous)' }),
});
