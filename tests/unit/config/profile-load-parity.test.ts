import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import { detectInstalledAgents } from '../../../src/cli/agent-detection.js';
import { loadRootConfig } from '../../../src/config/profile-store.js';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime.js';
import { writeScriptedJsonlExecutable } from '../../helpers/fake-executable.js';
import {
  envBinVar,
  PINNED_AGENT_KINDS,
  readScriptedRecords,
  scriptedJsonlLines,
  scriptedVersion,
  withProcessEnv,
} from '../../helpers/scripted-jsonl-cli.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/profiles', import.meta.url));
const BIN_ENV = Object.fromEntries(PINNED_AGENT_KINDS.map((kind) => [envBinVar(kind), undefined])) as Record<
  string,
  undefined
>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential('P4 profile load parity', () => {
  it('loads the env-var Kimi fixture and spawns LARK_CHANNEL_KIMI_BIN', async () => {
    const copied = await copyFixture('env-var-kimi');
    const root = await loadRootConfig(join(copied, 'config.json'));
    const profile = root?.profiles.kimi;
    expect(profile?.agentKind).toBe('kimi');
    expect(profile?.codex).toBeUndefined();

    const binDir = join(copied, 'bin');
    const fake = await writeScriptedJsonlExecutable(join(binDir, 'kimi-env-actual'), {
      lines: scriptedJsonlLines('kimi', 'happy'),
      version: scriptedVersion('kimi'),
    });
    const decoy = await writeScriptedJsonlExecutable(join(binDir, 'kimi'), {
      lines: scriptedJsonlLines('kimi', 'happy'),
      version: scriptedVersion('kimi'),
    });
    await withProcessEnv({ ...BIN_ENV, PATH: binDir, [envBinVar('kimi')]: fake.path }, async () => {
      const agent = createRuntimeAgent(profile!, { profileDir: join(copied, 'profiles', 'kimi') });
      expect(agent.id).toBe('kimi');
      await drain(agent, copied);
      expect(await readScriptedRecords(fake.recordPath)).toHaveLength(1);
      expect(await readScriptedRecords(decoy.recordPath)).toHaveLength(0);
    });
  });

  it('loads PATH Claude and Grok fixtures and spawns the command names on PATH', async () => {
    const claudeRoot = await copyFixture('path-claude');
    const grokRoot = await copyFixture('path-grok');
    const claudeProfile = (await loadRootConfig(join(claudeRoot, 'config.json')))?.profiles.claude;
    const grokProfile = (await loadRootConfig(join(grokRoot, 'config.json')))?.profiles.grok;
    expect(claudeProfile?.agentKind).toBe('claude');
    expect(grokProfile?.agentKind).toBe('grok');

    const binDir = join(claudeRoot, 'bin');
    const claude = await writeScriptedJsonlExecutable(join(binDir, 'claude'), {
      lines: scriptedJsonlLines('claude', 'happy'),
      version: scriptedVersion('claude'),
    });
    const grok = await writeScriptedJsonlExecutable(join(binDir, 'grok'), {
      lines: scriptedJsonlLines('grok', 'happy'),
      version: scriptedVersion('grok'),
    });
    await withProcessEnv({ ...BIN_ENV, PATH: binDir }, async () => {
      const claudeAgent = createRuntimeAgent(claudeProfile!, { profileDir: join(claudeRoot, 'profiles', 'claude') });
      const grokAgent = createRuntimeAgent(grokProfile!, { profileDir: join(grokRoot, 'profiles', 'grok') });
      expect(claudeAgent.id).toBe('claude');
      expect(grokAgent.id).toBe('grok');
      await drain(claudeAgent, claudeRoot);
      await drain(grokAgent, grokRoot);
      expect(await readScriptedRecords(claude.recordPath)).toHaveLength(1);
      expect(await readScriptedRecords(grok.recordPath)).toHaveLength(1);
    });
  });

  it('loads Codex binaryPath plus inheritCodexHome and ignores a PATH decoy', async () => {
    const copied = await copyFixture('codex-binary-path');
    const root = await loadRootConfig(join(copied, 'config.json'));
    const profile = root?.profiles.codex;
    expect(profile?.agentKind).toBe('codex');
    expect(profile?.codex).toMatchObject({
      binaryPath: '/opt/pin/codex',
      codexHome: '/state/codex-home',
      inheritCodexHome: false,
    });

    const fake = await writeScriptedJsonlExecutable(join(copied, 'opt-codex'), {
      lines: scriptedJsonlLines('codex', 'happy'),
      version: scriptedVersion('codex'),
    });
    const decoyDir = join(copied, 'decoy-bin');
    const decoy = await writeScriptedJsonlExecutable(join(decoyDir, 'codex'), {
      lines: scriptedJsonlLines('codex', 'happy'),
      version: scriptedVersion('codex'),
    });
    profile!.codex = { ...profile!.codex!, binaryPath: fake.path };
    await withProcessEnv({ ...BIN_ENV, PATH: decoyDir }, async () => {
      const agent = createRuntimeAgent(profile!, { profileDir: join(copied, 'profiles', 'codex') });
      expect(agent.id).toBe('codex');
      await drain(agent, copied);
      const records = await readScriptedRecords(fake.recordPath);
      expect(records).toHaveLength(1);
      expect(records[0]?.env.CODEX_HOME).toBe('/state/codex-home');
      expect(await readScriptedRecords(decoy.recordPath)).toHaveLength(0);
    });
  });

  it('detects Cursor via versioned agent on PATH and runtime resolveCursorBinary follows it', async () => {
    const copied = await copyFixture('cursor-versioned-agent');
    const root = await loadRootConfig(join(copied, 'config.json'));
    const profile = root?.profiles.cursor;
    expect(profile?.agentKind).toBe('cursor');
    expect(profile?.codex).toBeUndefined();

    const binDir = join(copied, 'bin');
    const agentBin = await writeScriptedJsonlExecutable(join(binDir, 'agent'), {
      lines: scriptedJsonlLines('cursor', 'happy'),
      version: 'cursor-agent 2026.08.28',
      help: 'Usage: --output-format stream-json --approve-mcps',
    });
    await withProcessEnv({ ...BIN_ENV, PATH: binDir }, async () => {
      await expect(detectInstalledAgents()).resolves.toEqual([{ kind: 'cursor', binaryPath: agentBin.path }]);
      const agent = createRuntimeAgent(profile!, { profileDir: join(copied, 'profiles', 'cursor') });
      expect(agent.id).toBe('cursor');
      await drain(agent, copied);
      expect(await readScriptedRecords(agentBin.recordPath)).toHaveLength(1);
    });
  });
});

async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pin-profile-${name}-`));
  roots.push(dir);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  await mkdir(join(dir, 'workspace', '.git'), { recursive: true });
  return dir;
}

async function drain(agent: ReturnType<typeof createRuntimeAgent>, cwd: string): Promise<void> {
  const opts = { runId: 'pin-p4', prompt: 'PIN_PROMPT', cwd };
  await agent.prepareRun?.(opts);
  await collect(agent.run(opts));
}

async function collect(run: AgentRun): Promise<void> {
  for await (const _event of run.events) {
    void _event;
  }
}
