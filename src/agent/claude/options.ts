import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

export const CLAUDE_DEFAULT_PERMISSION_MODE = 'bypassPermissions' as const;

const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export type ClaudeAgentOptions = {
  permissionMode?: ClaudePermissionMode;
};

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

export function parseClaudeAgentOptions(value: unknown, strict = false): ClaudeAgentOptions {
  const raw = asAgentOptionsObject(value, 'claude');
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (key !== 'permissionMode') {
        throw new Error(`unknown claude agent option: ${key}`);
      }
    }
  }
  if (raw.permissionMode === undefined) return {};
  if (!isClaudePermissionMode(raw.permissionMode)) {
    throw new Error(`invalid claude agent option permissionMode: ${String(raw.permissionMode)}`);
  }
  return { permissionMode: raw.permissionMode };
}

export const claudeAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseClaudeAgentOptions(value, true),
};

export function claudePolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export function mapClaudeEffectiveAccess(access: EffectiveAccess): unknown {
  switch (access) {
    case 'read-only':
      return { permissionMode: 'plan' };
    case 'workspace':
      return { permissionMode: 'acceptEdits' };
    case 'full':
      return { permissionMode: 'bypassPermissions' };
    default: {
      const _never: never = access;
      return _never;
    }
  }
}
