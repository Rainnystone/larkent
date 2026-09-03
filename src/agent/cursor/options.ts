import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

const CURSOR_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type CursorSandboxOption = (typeof CURSOR_SANDBOXES)[number];

export type CursorAgentOptions = {
  sandbox?: CursorSandboxOption;
};

function isCursorSandboxOption(value: unknown): value is CursorSandboxOption {
  return typeof value === 'string' && (CURSOR_SANDBOXES as readonly string[]).includes(value);
}

export function parseCursorAgentOptions(value: unknown, strict = false): CursorAgentOptions {
  const raw = asAgentOptionsObject(value, 'cursor');
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (key !== 'sandbox') {
        throw new Error(`unknown cursor agent option: ${key}`);
      }
    }
  }
  if (raw.sandbox === undefined) return {};
  if (!isCursorSandboxOption(raw.sandbox)) {
    throw new Error(`invalid cursor agent option sandbox: ${String(raw.sandbox)}`);
  }
  return { sandbox: raw.sandbox };
}

export const cursorAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseCursorAgentOptions(value, true),
};

export function cursorPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export function mapCursorEffectiveAccess(access: EffectiveAccess): unknown {
  switch (access) {
    case 'read-only':
      return { sandbox: 'read-only' };
    case 'workspace':
      return { sandbox: 'workspace-write' };
    case 'full':
      return { sandbox: 'danger-full-access' };
    default: {
      const _never: never = access;
      return _never;
    }
  }
}
