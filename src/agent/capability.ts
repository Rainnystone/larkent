import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';
import {
  descriptorFor,
  isAgentKind,
  unknownAgentKindMessage,
  type AgentKind,
} from './registry';

export type AgentCapabilityId = AgentKind;
export type AgentSessionKind =
  | 'claude-session'
  | 'codex-thread'
  | 'kimi-session'
  | 'grok-session'
  | 'cursor-session';
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
  return capabilityForProfile({
    agentKind: 'claude',
    permissions: profile?.permissions ?? { defaultAccess: 'full', maxAccess: 'full' },
  });
}

export function kimiCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForProfile({
    agentKind: 'kimi',
    permissions: profile?.permissions ?? { defaultAccess: 'full', maxAccess: 'full' },
  });
}

export function grokCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForProfile({
    agentKind: 'grok',
    permissions: profile?.permissions ?? { defaultAccess: 'full', maxAccess: 'full' },
  });
}

export function cursorCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForProfile({
    agentKind: 'cursor',
    permissions: profile?.permissions ?? { defaultAccess: 'full', maxAccess: 'full' },
  });
}

export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  if (!isAgentKind(profile.agentKind)) {
    throw new Error(unknownAgentKindMessage(profile.agentKind));
  }
  const maxAccess = profile.permissions.maxAccess ?? 'full';
  const { capabilities } = descriptorFor(profile.agentKind);
  return {
    agentId: capabilities.agentId,
    sessionKind: capabilities.sessionKind,
    promptInjection: capabilities.promptInjection,
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: capabilities.supportsNativeHistory,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [...capabilities.callback.legacyMarkers],
    },
    permissions: { maxAccess },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForProfile({ agentKind: 'codex', permissions: profile.permissions });
}
