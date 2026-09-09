import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import {
  cursorAgentOptionsSchema,
  cursorPolicyInputs,
  mapCursorEffectiveAccess,
} from './options';

export function cursorCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'cursor', 'cursor-session'> {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'cursor',
    sessionKind: 'cursor-session',
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

export const cursorMetadata = defineMetadata({
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
  requireInstalled: true,
  missingInstallMessage:
    '未检测到 Cursor CLI（cursor-agent / agent）。请先安装并登录后再创建 cursor profile。',
  agentOptionsSchema: cursorAgentOptionsSchema,
  policyInputs: cursorPolicyInputs,
  mapEffectiveAccess: mapCursorEffectiveAccess,
  capability: (profile) => cursorCapability(profile),
  runtimeAccess: () => ({ label: 'permission', value: 'force (cursor --force)' }),
});
