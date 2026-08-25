import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'kimi' | 'grok';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'kimi-session' | 'grok-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'argv-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
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
    permissions: {
      maxAccess,
    },
  };
}

export function kimiCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'kimi',
    sessionKind: 'kimi-session',
    // kimi has no append-system-prompt flag and `-p` ignores stdin, so the
    // bridge system prompt is prefixed into the argv prompt.
    promptInjection: 'argv-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function grokCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'grok',
    sessionKind: 'grok-session',
    // grok `--rules` appends to the system prompt without replacing the
    // coding prompt (`--system-prompt-override` would).
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  if (profile.agentKind === 'codex') return codexCapability(profile);
  if (profile.agentKind === 'kimi') return kimiCapability(profile);
  if (profile.agentKind === 'grok') return grokCapability(profile);
  return claudeCapability(profile);
}

/** Claude / Kimi / Grok persist a sessionId; Codex uses a threadId. */
export function usesNativeSessionId(agentId: AgentCapabilityId): boolean {
  return agentId === 'claude' || agentId === 'kimi' || agentId === 'grok';
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
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
    permissions: {
      maxAccess,
    },
  };
}
