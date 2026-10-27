import { expect } from 'vitest';

export function cardButtonValue(card: unknown, cmd: string): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.behaviors)) {
      for (const behavior of rec.behaviors) {
        const value = (behavior as { value?: unknown }).value;
        if (value && typeof value === 'object'
          && (value as Record<string, unknown>).cmd === cmd) {
          found = value as Record<string, unknown>;
          return;
        }
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(card);
  expect(found, `expected a ${cmd} button value`).toBeDefined();
  return found!;
}
