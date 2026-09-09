import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveCursorBinary } from '../../../src/cli/agent-detection.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { loadRootConfig } from '../../../src/config/profile-store.js';
import { createRuntimeAgent, resolveProfileBinary } from '../../../src/runtime/agent-runtime.js';
import { writeVersionExecutable, writeScriptedJsonlExecutableFile } from '../../helpers/fake-executable.js';
import {
  adapterDisplayName,
  cursorVersionedHelpText,
  withEnvBin,
  withIsolatedPath,
} from '../../helpers/scripted-jsonl-cli.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures/profiles');

describe('P4 profile load parity', () => {
  it.each([true, false])('isolates two fake Codex factories with inherited login %s', async (inherit) => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-codex-'));
    const parentHome = join(dir, 'parent-home');
    vi.stubEnv('CODEX_HOME', parentHome);
    const warnings = vi.spyOn(console, 'warn');
    try {
      const binaries = await Promise.all(['a', 'b'].map(async (name) => {
        const binary = join(dir, `${name}.mjs`);
        await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk.toString();
writeFileSync(${JSON.stringify(join(dir, name + '.json'))}, JSON.stringify({
  argv: process.argv.slice(2), home: process.env.CODEX_HOME, stdin,
}));
console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(name)} }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
        return binary;
      }));
      const accounts = { app: { id: 'fake-app', secret: 'fake-secret', tenant: 'feishu' as const } };
      const a = createDefaultProfileConfig({
        agentKind: 'codex', accounts,
        codex: { binaryPath: '/fake/unused-codex', inheritCodexHome: true, ignoreRules: false },
      });
      a.agent.binaryPath = binaries[0]!;
      a.agent.options = { codexHome: join(dir, 'explicit-home'), inheritCodexHome: false, ignoreRules: true };
      const b = createDefaultProfileConfig({
        agentKind: 'codex', accounts,
        codex: { binaryPath: binaries[1]!, inheritCodexHome: inherit, ignoreRules: false },
      });
      // Exercise the legacy Codex fallback independently of agent.binaryPath.
      delete b.agent.binaryPath;
      expect(resolveProfileBinary(a)).toBe(binaries[0]);
      expect(resolveProfileBinary(b)).toBe(binaries[1]);
      const adapters = [
        createRuntimeAgent(a, { profileDir: join(dir, 'profile-a') }),
        createRuntimeAgent(b, { profileDir: join(dir, 'profile-b') }),
      ];
      expect(adapters[0]).not.toBe(adapters[1]);
      await Promise.all(adapters.map(async (adapter, index) => {
        const run = adapter.run({ runId: `fake-${index}`, prompt: 'hello', cwd: dir });
        const events = [];
        for await (const event of run.events) events.push(event);
        expect(await run.waitForExit(5000)).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
        expect(events).toContainEqual(expect.objectContaining({ type: 'system', resumeHandle: index === 0 ? 'a' : 'b' }));
      }));
      const first = JSON.parse(await readFile(join(dir, 'a.json'), 'utf8'));
      const second = JSON.parse(await readFile(join(dir, 'b.json'), 'utf8'));
      expect(first.home).toBe(join(dir, 'explicit-home'));
      expect(second.home).toBe(inherit ? parentHome : join(dir, 'profile-b', 'codex-home'));
      expect(first.argv).toContain('--ignore-rules');
      expect(second.argv).not.toContain('--ignore-rules');
      expect(process.env.CODEX_HOME).toBe(parentHome);
      expect(first.stdin).toContain('hello');
      expect(second.stdin).toContain('hello');
      expect(warnings.mock.calls.filter(args => args.join(' ').includes('stdin-error'))).toEqual([]);
    } finally {
      warnings.mockRestore();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads env-var kimi and grok profiles to the same runtime adapter as today', async () => {
    const fixture = join(fixtureRoot, 'env-var/config.json');
    const before = await readFile(fixture, 'utf8');
    expect(JSON.parse(before).schemaVersion).toBe(2);
    const root = await loadRootConfig(fixture);
    expect(await readFile(fixture, 'utf8')).toBe(before);
    expect(root?.schemaVersion).toBe(3);
    expect(root?.profiles.kimi?.agentKind).toBe('kimi');
    expect(root?.profiles.grok?.agentKind).toBe('grok');
    expect(root?.profiles.kimi?.agent).toEqual({ kind: 'kimi' });
    expect(root?.profiles.grok?.agent).toEqual({ kind: 'grok' });
    expect(root?.profiles.kimi?.codex).toBeUndefined();
    expect(root?.profiles.grok?.codex).toBeUndefined();
    expect(root?.profiles.kimi).not.toHaveProperty('binaryPath');
    expect(root?.profiles.grok).not.toHaveProperty('binaryPath');

    const dir = await mkdtemp(join(tmpdir(), 'pin-env-bin-'));
    await writeVersionExecutable(dir, 'kimi', 'kimi 0.0.0-pin');
    await writeVersionExecutable(dir, 'grok', 'grok 0.0.0-pin');

    await withEnvBin('kimi', undefined, async () => {
      await withEnvBin('grok', undefined, async () => {
        await withIsolatedPath(dir, async () => {
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
  });

  it('loads a PATH claude profile to the same runtime adapter as today', async () => {
    const root = await loadRootConfig(join(fixtureRoot, 'path-claude/config.json'));
    expect(root?.profiles.claude?.agentKind).toBe('claude');
    expect(root?.profiles.claude?.agent).toEqual({ kind: 'claude' });
    expect(root?.profiles.claude?.agent).not.toHaveProperty('binaryPath');
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
    expect(root?.profiles.codex?.agent).toEqual({
      kind: 'codex',
      binaryPath: '/opt/pinned/codex',
    });
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
    expect(root?.profiles.cursor?.agent).toEqual({ kind: 'cursor' });
    expect(root?.profiles.cursor?.agent).not.toHaveProperty('binaryPath');
    const dir = await mkdtemp(join(tmpdir(), 'pin-cursor-agent-'));
    const agentBin = join(dir, process.platform === 'win32' ? 'agent.CMD' : 'agent');
    // Support both probes: detection may fall back from version to Cursor-specific help.
    await writeScriptedJsonlExecutableFile(agentBin, agentBin + '.argv.json', {
      version: 'cursor-agent 2026.08.28-pin',
      helpText: cursorVersionedHelpText(),
    });
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
