import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

export type KimiAgentOptions = Record<string, never>;

export function parseKimiAgentOptions(value: unknown, strict = false): KimiAgentOptions {
  const raw = asAgentOptionsObject(value, 'kimi');
  if (strict) {
    for (const key of Object.keys(raw)) {
      throw new Error(`unknown kimi agent option: ${key}`);
    }
  }
  return {};
}

export const kimiAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseKimiAgentOptions(value, true),
};

export function kimiPolicyInputs(_options: unknown): Record<string, unknown> {
  return {};
}

export function mapKimiEffectiveAccess(_access: EffectiveAccess): unknown {
  return {};
}
