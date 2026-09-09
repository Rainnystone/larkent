import type { ProfileConfig } from '../config/profile-schema';
import type { LarkChannelEnvContext } from './lark-channel-env';
import type { AgentAdapter, AgentOptionsSchema, EffectiveAccess } from './types';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

export type AgentReplyMode = 'stream-deltas' | 'final-answer';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'argv-prefix';

export interface CapabilityShape<K extends string = string, S extends string = string> {
  agentId: K;
  sessionKind: S;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: EffectiveAccess;
  };
}

export interface AgentMetadata<K extends string = string, S extends string = string> {
  readonly kind: K;
  readonly displayName: string;
  readonly binaryNames: readonly string[];
  readonly envBinVar: string;
  readonly models: readonly ModelOption[];
  readonly replyMode: AgentReplyMode;
  readonly resume: { readonly flag: string; readonly label: 'session' | 'thread' };
  readonly sessionKind: S;
  readonly promptInjection: PromptInjectionMode;
  readonly supportsNativeHistory: boolean;
  readonly requireInstalled: boolean;
  readonly missingInstallMessage: string;
  readonly agentOptionsSchema: AgentOptionsSchema;
  readonly policyInputs: (options: unknown) => Record<string, unknown>;
  readonly mapEffectiveAccess: (access: EffectiveAccess) => unknown;
  readonly historyEnv?: (profile: ProfileConfig) => Record<string, unknown>;
  capability(profile?: Pick<ProfileConfig, 'permissions'>): CapabilityShape<K, S>;
  runtimeAccess(profile: ProfileConfig): { label: string; value: string };
}

export const FOLLOW_DEFAULT: ModelOption = Object.freeze({
  value: 'default',
  label: '跟随默认（不指定）',
});

export function defineMetadata<K extends string, S extends string>(
  value: AgentMetadata<K, S>,
): AgentMetadata<K, S> {
  return Object.freeze(value);
}

export interface AgentFactoryContext {
  profile: ProfileConfig;
  profileDir: string;
  larkChannel?: LarkChannelEnvContext;
}

export interface ResumeHistoryEntry {
  resumeHandle: string;
  preview: string;
  updatedAtMs: number;
  lineCount?: number;
  detail?: string;
}

export interface ResumeHistoryInput {
  profile: ProfileConfig;
  profileDir: string;
  cwd: string;
  limit: number;
}

export interface AgentDescriptorShape<K extends string = string, S extends string = string>
  extends AgentMetadata<K, S> {
  readonly acceptsImagePaths: boolean;
  readonly acceptsRawResumeHandle: boolean;
  listResumeHistory(input: ResumeHistoryInput): Promise<ResumeHistoryEntry[]>;
  create(context: AgentFactoryContext): AgentAdapter;
  resolveProfileBinary(profile: ProfileConfig): string | undefined;
  detectBinary(envCommand?: string): Promise<string>;
  readonly detectionOrder: number;
}

export function defineDescriptor<K extends string, S extends string>(
  value: AgentDescriptorShape<K, S>,
): AgentDescriptorShape<K, S> {
  return Object.freeze(value);
}
