import { claudeMetadata } from './claude/metadata';
import { codexMetadata } from './codex/metadata';
import { cursorMetadata } from './cursor/metadata';
import { grokMetadata } from './grok/metadata';
import { kimiMetadata } from './kimi/metadata';

export const registeredAgentDescriptors = [
  claudeMetadata,
  codexMetadata,
  kimiMetadata,
  grokMetadata,
  cursorMetadata,
] as const;

export type AgentDescriptor = (typeof registeredAgentDescriptors)[number];
export type AgentKind = AgentDescriptor['kind'];
export type { AgentReplyMode } from './definition';

export const AGENT_KINDS = Object.freeze(
  registeredAgentDescriptors.map((descriptor) => descriptor.kind),
);
export const AGENT_REGISTRY: ReadonlyMap<AgentKind, AgentDescriptor> = new Map<
  AgentKind,
  AgentDescriptor
>(registeredAgentDescriptors.map((descriptor) => [descriptor.kind, descriptor]));

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && AGENT_REGISTRY.has(value as AgentKind);
}

export function unknownAgentKindMessage(value: unknown): string {
  return `unknown agent kind: ${String(value)}. supported: ${AGENT_KINDS.join(', ')}`;
}

export function descriptorFor(kind: AgentKind): AgentDescriptor {
  const descriptor = AGENT_REGISTRY.get(kind);
  if (!descriptor) throw new Error(unknownAgentKindMessage(kind));
  return descriptor;
}

export function requireAgentKind(value: unknown): AgentKind {
  if (isAgentKind(value)) return value;
  throw new Error(unknownAgentKindMessage(value));
}

export function agentKindChoices(): string {
  return AGENT_KINDS.join(', ');
}

export function agentKindFlagChoices(): string {
  return AGENT_KINDS.join('|');
}
