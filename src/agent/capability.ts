import type { ProfileConfig } from '../config/profile-schema';
import { antigravityCapability } from './antigravity/metadata';
import { claudeCapability } from './claude/metadata';
import { codexCapability } from './codex/metadata';
import { cursorCapability } from './cursor/metadata';
import { grokCapability } from './grok/metadata';
import { kimiCapability } from './kimi/metadata';
import { descriptorFor, type AgentDescriptor } from './registry';

export {
  antigravityCapability,
  claudeCapability,
  codexCapability,
  cursorCapability,
  grokCapability,
  kimiCapability,
};
export type { PromptInjectionMode } from './definition';

export type AgentCapability = ReturnType<AgentDescriptor['capability']>;
export type AgentCapabilityId = AgentCapability['agentId'];
export type AgentSessionKind = AgentCapability['sessionKind'];

export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  return descriptorFor(profile.agentKind).capability(profile);
}
