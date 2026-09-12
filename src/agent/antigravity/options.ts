import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

const ANTIGRAVITY_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const ANTIGRAVITY_OPTION_KEYS = new Set(['sandbox', 'printTimeout']);
const AGY_DURATION = /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/;

export type AntigravitySandboxOption = (typeof ANTIGRAVITY_SANDBOXES)[number];

export type AntigravityAgentOptions = {
  sandbox?: AntigravitySandboxOption;
  /** agy `--print-timeout` duration. Unset omits the flag (agy default). */
  printTimeout?: string;
};

function isAntigravitySandboxOption(value: unknown): value is AntigravitySandboxOption {
  return typeof value === 'string' && (ANTIGRAVITY_SANDBOXES as readonly string[]).includes(value);
}

function isAgyPrintTimeout(value: unknown): value is string {
  return typeof value === 'string' && AGY_DURATION.test(value) && /[1-9]/.test(value);
}

export function parseAntigravityAgentOptions(
  value: unknown,
  strict = false,
): AntigravityAgentOptions {
  const raw = asAgentOptionsObject(value, 'antigravity');
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!ANTIGRAVITY_OPTION_KEYS.has(key)) {
        throw new Error(`unknown antigravity agent option: ${key}`);
      }
    }
  }
  const options: AntigravityAgentOptions = {};
  if (raw.sandbox !== undefined) {
    if (!isAntigravitySandboxOption(raw.sandbox)) {
      throw new Error(`invalid antigravity agent option sandbox: ${String(raw.sandbox)}`);
    }
    options.sandbox = raw.sandbox;
  }
  if (raw.printTimeout !== undefined) {
    if (!isAgyPrintTimeout(raw.printTimeout)) {
      throw new Error(`invalid antigravity agent option printTimeout: ${String(raw.printTimeout)}`);
    }
    options.printTimeout = raw.printTimeout;
  }
  return options;
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
