import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

const ANTIGRAVITY_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const ANTIGRAVITY_OPTION_KEYS = new Set(['sandbox', 'printTimeout']);
const AGY_DURATION = /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/;
const AGY_DURATION_TOKEN = /(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h)/g;
const MAX_GO_DURATION_NS = 9_223_372_036_854_775_807n;
const UNIT_NS = {
  ns: 1n,
  us: 1_000n,
  'µs': 1_000n,
  'μs': 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
} as const;

export type AntigravitySandboxOption = (typeof ANTIGRAVITY_SANDBOXES)[number];

export type AntigravityAgentOptions = {
  sandbox?: AntigravitySandboxOption;
  /** agy `--print-timeout` duration. Unset omits the flag (agy default). */
  printTimeout?: string;
};

function isAntigravitySandboxOption(value: unknown): value is AntigravitySandboxOption {
  return typeof value === 'string' && (ANTIGRAVITY_SANDBOXES as readonly string[]).includes(value);
}

function goDurationTokenNs(token: string): bigint | undefined {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)$/.exec(token);
  if (!match) return undefined;
  const amount = match[1];
  const unit = match[2];
  if (amount === undefined || unit === undefined || !(unit in UNIT_NS)) return undefined;
  const unitNs = UNIT_NS[unit as keyof typeof UNIT_NS];
  const dot = amount.indexOf('.');
  const intPart = dot === -1 ? amount : amount.slice(0, dot) || '0';
  const fracPart = dot === -1 ? '' : amount.slice(dot + 1);
  let ns = BigInt(intPart) * unitNs;
  if (fracPart) ns += (BigInt(fracPart) * unitNs) / 10n ** BigInt(fracPart.length);
  return ns;
}

function isPositiveRepresentableGoDuration(value: string): boolean {
  if (!AGY_DURATION.test(value)) return false;
  let total = 0n;
  for (const token of value.match(AGY_DURATION_TOKEN) ?? []) {
    const ns = goDurationTokenNs(token);
    if (ns === undefined) return false;
    total += ns;
    if (total <= 0n || total > MAX_GO_DURATION_NS) return false;
  }
  return total > 0n;
}

function isAgyPrintTimeout(value: unknown): value is string {
  return typeof value === 'string' && isPositiveRepresentableGoDuration(value);
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
