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
  it.each(['claude', 'codex', 'kimi', 'grok', 'cursor'] as const)(
    'creates independent %s profile adapters with descriptor capabilities', (kind) => {
      const profile = createDefaultProfileConfig({
        agentKind: kind,
        ...(kind === 'codex' ? { codex: { binaryPath: '/fake/codex' } } : {}),
        accounts: { app: { id: 'fake-app', secret: 'fake-secret', tenant: 'feishu' } },
      });
      profile.agent.binaryPath = '/fake/' + kind;
      if (profile.codex) profile.codex.binaryPath = '/fake/legacy-codex';
      const descriptor = descriptorFor(kind);
      const context = { profile, profileDir: '/fake/profile' };
      const first = descriptor.create(context);
      const second = descriptor.create(context);
      expect(first).not.toBe(second);
      expect(first.id).toBe(kind);
      expect(second.id).toBe(kind);
      expect(capabilityForProfile(profile)).toEqual(descriptor.capability(profile));
    },
  );

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

  it.each([
    ['claude', '--resume', 'claude-session'],
    ['codex', 'resume', 'codex-thread'],
    ['kimi', '-S', 'kimi-session'],
    ['grok', '-r', 'grok-session'],
    ['cursor', '--resume', 'cursor-session'],
  ] as const)('keeps %s metadata', (kind, flag, sessionKind) => {
    const descriptor = descriptorFor(kind);
    expect(descriptor.resume.flag).toBe(flag);
    expect(descriptor.sessionKind).toBe(sessionKind);
    expect(
      descriptor.capability({
        permissions: { defaultAccess: 'workspace', maxAccess: 'full' },
      }),
    ).toMatchObject({ agentId: kind, sessionKind });
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
