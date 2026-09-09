import type { ProfileConfig } from '../../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from '../bridge-system-prompt';
import {
  defineMetadata,
  FOLLOW_DEFAULT,
  type CapabilityShape,
} from '../definition';
import {
  codexAgentOptionsSchema,
  codexPolicyInputs,
  codexThreadHistoryEnv,
  mapCodexEffectiveAccess,
} from './options';

export function codexCapability(
  profile: Pick<ProfileConfig, 'permissions'>,
): CapabilityShape<'codex', 'codex-thread'> {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: { maxAccess },
  };
}

export const codexMetadata = defineMetadata({
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
  requireInstalled: false,
  missingInstallMessage: '未检测到 Codex CLI（codex）。请先安装并登录后再创建 codex profile。',
  agentOptionsSchema: codexAgentOptionsSchema,
  policyInputs: codexPolicyInputs,
  mapEffectiveAccess: mapCodexEffectiveAccess,
  historyEnv: (profile) => codexThreadHistoryEnv(profile),
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
});
