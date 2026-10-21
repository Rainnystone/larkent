import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

export const DEVIN_DEFAULT_PERMISSION_MODE = 'dangerous' as const;

const DEVIN_PERMISSION_MODES = [
  'auto',
  'accept-edits',
  'smart',
  'dangerous',
  'autonomous',
] as const;

export type DevinPermissionMode = (typeof DEVIN_PERMISSION_MODES)[number];

export type DevinAgentOptions = {
  permissionMode?: DevinPermissionMode;
  sandbox?: boolean;
};

function isDevinPermissionMode(value: unknown): value is DevinPermissionMode {
  return (
    typeof value === 'string' &&
    (DEVIN_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function parseDevinAgentOptions(value: unknown, strict = false): DevinAgentOptions {
  const raw = asAgentOptionsObject(value, 'devin');
  const allowed = new Set(['permissionMode', 'sandbox']);
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        throw new Error(`unknown devin agent option: ${key}`);
      }
    }
  }
  const options: DevinAgentOptions = {};
  const permissionMode = toDevinPermissionMode(raw.permissionMode);
  if (raw.permissionMode !== undefined && !permissionMode) {
    throw new Error(
      `invalid devin agent option permissionMode: ${String(raw.permissionMode)}`,
    );
  }
  if (permissionMode) options.permissionMode = permissionMode;
  if (raw.sandbox !== undefined) {
    // Policy injects Codex sandbox names here; they are access-level hints, not
    // Devin's boolean --sandbox flag, so only an explicit boolean opts in.
    if (typeof raw.sandbox !== 'boolean') {
      if (strict) throw new Error('invalid devin agent option sandbox');
    } else {
      options.sandbox = raw.sandbox;
    }
  }
  return options;
}

export const devinAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseDevinAgentOptions(value, true),
};

export function devinPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

/**
 * Normalize profile-native names and the shared policy vocabulary before
 * resolving ACP mode selectors. Native sandbox is parsed separately from the
 * shared policy's string-valued access hint.
 */
export function toDevinPermissionMode(value: unknown): DevinPermissionMode | undefined {
  if (!value) return undefined;
  if (isDevinPermissionMode(value)) return value;
  switch (value) {
    case 'plan':
      return 'auto';
    case 'default':
    case 'acceptEdits':
      return 'accept-edits';
    case 'dontAsk':
      return 'smart';
    case 'bypassPermissions':
      return 'dangerous';
    default:
      return undefined;
  }
}

/** Existing generic policy vocabulary; acp-config resolves the native mode. */
export function mapDevinEffectiveAccess(access: EffectiveAccess): unknown {
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
