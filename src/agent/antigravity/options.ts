import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

const ANTIGRAVITY_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type AntigravitySandboxOption = (typeof ANTIGRAVITY_SANDBOXES)[number];

export type AntigravityAgentOptions = {
  sandbox?: AntigravitySandboxOption;
};

function isAntigravitySandboxOption(value: unknown): value is AntigravitySandboxOption {
  return typeof value === 'string' && (ANTIGRAVITY_SANDBOXES as readonly string[]).includes(value);
}

export function parseAntigravityAgentOptions(
  value: unknown,
  strict = false,
): AntigravityAgentOptions {
  const raw = asAgentOptionsObject(value, 'antigravity');
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (key !== 'sandbox') {
        throw new Error(`unknown antigravity agent option: ${key}`);
      }
    }
  }
  if (raw.sandbox === undefined) return {};
  if (!isAntigravitySandboxOption(raw.sandbox)) {
    throw new Error(`invalid antigravity agent option sandbox: ${String(raw.sandbox)}`);
  }
  return { sandbox: raw.sandbox };
}

export const antigravityAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseAntigravityAgentOptions(value, true),
};

export function antigravityPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export function mapAntigravityEffectiveAccess(access: EffectiveAccess): unknown {
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
