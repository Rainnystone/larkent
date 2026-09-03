import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  claudeCapability,
  capabilityForProfile,
  codexCapability,
  cursorCapability,
  grokCapability,
  kimiCapability,
} from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('defines Kimi capability with session-id resume and argv prompt injection', () => {
    const capability = kimiCapability();

    expect(capability).toMatchObject({
      agentId: 'kimi',
      sessionKind: 'kimi-session',
      promptInjection: 'argv-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'full',
      },
    });
  });

  it('uses Kimi profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'kimi',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(kimiCapability(profile).permissions.maxAccess).toBe('workspace');
  });

  it('defines Grok capability with session-id resume and rules prompt injection', () => {
    const capability = grokCapability();

    expect(capability).toMatchObject({
      agentId: 'grok',
      sessionKind: 'grok-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'full',
      },
    });
  });

  it('uses Grok profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'grok',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(grokCapability(profile).permissions.maxAccess).toBe('workspace');
    expect(capabilityForProfile(profile).agentId).toBe('grok');
  });

  it('defines Cursor capability with session-id resume and argv prompt injection', () => {
    const capability = cursorCapability();

    expect(capability).toMatchObject({
      agentId: 'cursor',
      sessionKind: 'cursor-session',
      promptInjection: 'argv-prefix',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'full',
      },
    });
  });

  it('uses Cursor profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'cursor',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(cursorCapability(profile).permissions.maxAccess).toBe('workspace');
    expect(capabilityForProfile(profile).agentId).toBe('cursor');
  });
});
