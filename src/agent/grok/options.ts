import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

export type GrokAgentOptions = Record<string, never>;

export function parseGrokAgentOptions(value: unknown, strict = false): GrokAgentOptions {
  const raw = asAgentOptionsObject(value, 'grok');
  if (strict) {
    for (const key of Object.keys(raw)) {
      throw new Error(`unknown grok agent option: ${key}`);
    }
  }
  return {};
}

export const grokAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseGrokAgentOptions(value, true),
};

export function grokPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export interface GrokAccessFlags {
  permissionMode: string;
  sandbox: string;
}

/**
 * Grok 1.0.41 flags for a clamped access mode.
 * `--permission-mode bypassPermissions` is always-approve; read-only must not
 * pass that flag. Sandbox names are Grok profiles (`workspace`, not Codex's
 * `workspace-write`).
 */
export function grokAccessFlags(access: EffectiveAccess): GrokAccessFlags {
  switch (access) {
    case 'read-only':
      return { permissionMode: 'plan', sandbox: 'read-only' };
    case 'workspace':
      return { permissionMode: 'acceptEdits', sandbox: 'workspace' };
    case 'full':
      return { permissionMode: 'bypassPermissions', sandbox: 'off' };
    default: {
      const _never: never = access;
      return _never;
    }
  }
}

export function grokAccessStatus(access: EffectiveAccess): string {
  const flags = grokAccessFlags(access);
  return `${flags.permissionMode} (grok --permission-mode ${flags.permissionMode} --sandbox ${flags.sandbox})`;
}

export function mapGrokEffectiveAccess(access: EffectiveAccess): GrokAccessFlags {
  return grokAccessFlags(access);
}

const GROK_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);

/** Policy passes Claude permission names; they already match Grok's mode list. */
export function toGrokPermissionMode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return GROK_PERMISSION_MODES.has(value) ? value : undefined;
}

/** Policy passes Codex sandbox names. Map them onto Grok profiles. */
export function toGrokSandbox(value: string | undefined): string | undefined {
  switch (value) {
    case undefined:
    case '':
      return undefined;
    case 'read-only':
      return 'read-only';
    case 'workspace':
    case 'workspace-write':
      return 'workspace';
    case 'danger-full-access':
    case 'off':
    case 'full':
      return 'off';
    case 'strict':
      return 'strict';
    default:
      return undefined;
  }
}
