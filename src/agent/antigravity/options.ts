import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

export type AntigravityAgentOptions = Record<string, never>;

export function parseAntigravityAgentOptions(
  value: unknown,
  strict = false,
): AntigravityAgentOptions {
  const raw = asAgentOptionsObject(value, 'antigravity');
  if (strict) {
    for (const key of Object.keys(raw)) {
      throw new Error(`unknown antigravity agent option: ${key}`);
    }
  }
  return {};
}

export const antigravityAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseAntigravityAgentOptions(value, true),
};

export function antigravityPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export function mapAntigravityEffectiveAccess(_access: EffectiveAccess): unknown {
  return {};
}
