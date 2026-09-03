import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCursorBinary } from '../../../src/cli/agent-detection.js';
import { loadRootConfig } from '../../../src/config/profile-store.js';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';
import {
  adapterDisplayName,
  cursorVersionedHelpText,
  installKindCli,
  withEnvBin,
  withIsolatedPath,
} from '../../helpers/scripted-jsonl-cli.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/profiles');

describe('P4 profile load parity', () => {
  it('loads env-var kimi and grok profiles to the same runtime adapter as today', async () => {
    const root = await loadRootConfig(join(fixtureRoot, 'env-var/config.json'));
    expect(root?.profiles.kimi?.agentKind).toBe('kimi');
    expect(root?.profiles.grok?.agentKind).toBe('grok');
    expect(root?.profiles.kimi?.codex).toBeUndefined();
    expect(root?.profiles.grok?.codex).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'pin-env-bin-'));
    const kimi = await installKindCli(dir, 'kimi');
    const grok = await installKindCli(dir, 'grok');

    await withEnvBin('kimi', kimi.fake.path, async () => {
      await withEnvBin('grok', grok.fake.path, async () => {
        const kimiAgent = createRuntimeAgent(root!.profiles.kimi!, {
          profileDir: join(dir, 'profiles', 'kimi'),
        });
        const grokAgent = createRuntimeAgent(root!.profiles.grok!, {
          profileDir: join(dir, 'profiles', 'grok'),
        });
        expect(kimiAgent.id).toBe('kimi');
        expect(kimiAgent.displayName).toBe(adapterDisplayName('kimi'));
        expect(grokAgent.id).toBe('grok');
        expect(grokAgent.displayName).toBe(adapterDisplayName('grok'));
        await expect(kimiAgent.isAvailable()).resolves.toBe(true);
        await expect(grokAgent.isAvailable()).resolves.toBe(true);
      });
    });
  });

  it('loads a PATH claude profile to the same runtime adapter as today', async () => {
    const root = await loadRootConfig(join(fixtureRoot, 'path-claude/config.json'));
    expect(root?.profiles.claude?.agentKind).toBe('claude');
    const dir = await mkdtemp(join(tmpdir(), 'pin-path-claude-'));
    await writeVersionExecutable(dir, 'claude', 'claude 0.0.0-pin');
    await withEnvBin('claude', undefined, async () => {
      await withIsolatedPath(dir, async () => {
        const agent = createRuntimeAgent(root!.profiles.claude!, {
          profileDir: join(dir, 'profiles', 'claude'),
        });
        expect(agent.id).toBe('claude');
        expect(agent.displayName).toBe(adapterDisplayName('claude'));
        await expect(agent.isAvailable()).resolves.toBe(true);
      });
    });
  });

  it('loads a Codex binaryPath profile to the stored binary path', async () => {
    const root = await loadRootConfig(join(fixtureRoot, 'codex-binary-path/config.json'));
    expect(root?.profiles.codex?.agentKind).toBe('codex');
    expect(root?.profiles.codex?.codex).toMatchObject({
      binaryPath: '/opt/pinned/codex',
      inheritCodexHome: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'pin-codex-bin-'));
    const agent = createRuntimeAgent(root!.profiles.codex!, {
      profileDir: join(dir, 'profiles', 'codex'),
    });
    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe(adapterDisplayName('codex'));
  });

  it('loads a Cursor versioned-agent profile through resolveCursorBinary', async () => {
    const root = await loadRootConfig(join(fixtureRoot, 'cursor-versioned-agent/config.json'));
    expect(root?.profiles.cursor?.agentKind).toBe('cursor');
    const dir = await mkdtemp(join(tmpdir(), 'pin-cursor-agent-'));
    const agentBin = await writeVersionExecutable(dir, 'agent', 'cursor-agent 2026.08.28-pin');
    await withEnvBin('cursor', undefined, async () => {
      await withIsolatedPath(dir, async () => {
        await expect(resolveCursorBinary()).resolves.toBe(agentBin);
        const agent = createRuntimeAgent(root!.profiles.cursor!, {
          profileDir: join(dir, 'profiles', 'cursor'),
        });
        expect(agent.id).toBe('cursor');
        expect(agent.displayName).toBe(adapterDisplayName('cursor'));
        await expect(agent.isAvailable()).resolves.toBe(true);
      });
    });
    expect(cursorVersionedHelpText()).toContain('--approve-mcps');
  });
});
