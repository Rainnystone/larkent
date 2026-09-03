import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  descriptorFor,
  isAgentKind,
  requireAgentKind,
  unknownAgentKindMessage,
} from '../../../src/agent/registry.js';
import { capabilityForProfile } from '../../../src/agent/capability.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';

describe('agent registry', () => {
  it('lists kinds in registry order with no default', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'kimi', 'grok', 'cursor']);
    expect(AGENT_KINDS[0]).not.toBe('grok');
  });

  it('looks up descriptors without a claude fallthrough', () => {
    for (const kind of AGENT_KINDS) {
      expect(descriptorFor(kind).kind).toBe(kind);
      expect(descriptorFor(kind).displayName.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown kinds and lists AGENT_KINDS', () => {
    expect(isAgentKind('nope')).toBe(false);
    expect(() => requireAgentKind('nope')).toThrow(/claude, codex, kimi, grok, cursor/);
    expect(unknownAgentKindMessage('nope')).toContain('nope');
  });

  it('builds capability from the descriptor kind', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'kimi',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
    });
    expect(capabilityForProfile(profile).agentId).toBe('kimi');
  });
});
