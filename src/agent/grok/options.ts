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

export function mapGrokEffectiveAccess(_access: EffectiveAccess): unknown {
  return {};
}
