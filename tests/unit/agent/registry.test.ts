import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  descriptorFor,
  isAgentKind,
  parseAgentKind,
  requireAgentKind,
  unknownAgentKindMessage,
} from '../../../src/agent/registry';
import { capabilityForProfile } from '../../../src/agent/capability';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { tmpdir } from 'node:os';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('agent registry', () => {
  it('lists the five kinds in registry order with no default', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'kimi', 'grok', 'cursor']);
    expect(AGENT_KINDS[0]).not.toBe('grok');
  });

  it('looks up every kind and rejects unknown values while listing AGENT_KINDS', () => {
    for (const kind of AGENT_KINDS) {
      expect(isAgentKind(kind)).toBe(true);
      expect(descriptorFor(kind).kind).toBe(kind);
    }
    expect(isAgentKind('nope')).toBe(false);
    expect(() => requireAgentKind('nope')).toThrow(/claude, codex, kimi, grok, cursor/);
    expect(unknownAgentKindMessage('nope')).toContain('claude, codex, kimi, grok, cursor');
    expect(parseAgentKind(undefined)).toBeUndefined();
    expect(parseAgentKind('')).toBeUndefined();
    expect(parseAgentKind('cursor')).toBe('cursor');
    expect(() => requireAgentKind(undefined)).toThrow(
      /unknown agent kind undefined; expected one of: claude, codex, kimi, grok, cursor/,
    );
  });

  it('throws at profile load for agentKind nope and lists AGENT_KINDS', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'nope',
        accounts: { app },
      }),
    ).toThrow(/unknown agent kind nope; expected one of: claude, codex, kimi, grok, cursor/);
  });

  it('throws from capabilityForProfile for an unknown kind', () => {
    expect(() =>
      capabilityForProfile({
        agentKind: 'nope' as never,
        permissions: { defaultAccess: 'full', maxAccess: 'full' },
      }),
    ).toThrow(/claude, codex, kimi, grok, cursor/);
  });

  it('throws from createRuntimeAgent for an unknown kind', () => {
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    expect(() =>
      createRuntimeAgent({ ...profile, agentKind: 'nope' as never }, { profileDir: tmpdir() }),
    ).toThrow(/claude, codex, kimi, grok, cursor/);
  });
});
