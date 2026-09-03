import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { detectInstalledAgents } from '../../../src/cli/agent-detection.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { writeScriptedJsonlExecutable, writeVersionExecutable } from '../../helpers/fake-executable.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import {
  PINNED_AGENT_KINDS,
  createPinnedAdapter,
  envBinVar,
  pinnedDisplayName,
  scriptedBinaryName,
  scriptedJsonlLines,
  scriptedVersion,
  withProcessEnv,
  type PinnedAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const BIN_ENV = Object.fromEntries(PINNED_AGENT_KINDS.map((kind) => [envBinVar(kind), undefined])) as Record<
  string,
  undefined
>;

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential('P7 detection and /doctor parity', () => {
  it('detectInstalledAgents reports grok, claude, codex, kimi, then cursor from PATH', async () => {
    const root = await makeRoot();
    const written = {} as Record<PinnedAgentKind, { path: string }>;
    for (const kind of PINNED_AGENT_KINDS) {
      written[kind] = await writeScriptedJsonlExecutable(join(root, scriptedBinaryName(kind)), {
        lines: scriptedJsonlLines(kind, 'doctor'),
        version: scriptedVersion(kind),
      });
    }
    await withProcessEnv({ ...BIN_ENV, PATH: root }, async () => {
      const detected = await detectInstalledAgents();
      expect(detected.map((row) => row.kind)).toEqual(['grok', 'claude', 'codex', 'kimi', 'cursor']);
      expect(detected).toEqual([
        { kind: 'grok', binaryPath: written.grok.path },
        { kind: 'claude', binaryPath: written.claude.path },
        { kind: 'codex', binaryPath: written.codex.path },
        { kind: 'kimi', binaryPath: written.kimi.path },
        { kind: 'cursor', binaryPath: written.cursor.path },
      ]);
    });
  });

  it('detectInstalledAgents reports nothing when PATH and env bins are empty', async () => {
    const empty = await makeRoot();
    await withProcessEnv({ ...BIN_ENV, PATH: empty }, async () => {
      await expect(detectInstalledAgents()).resolves.toEqual([]);
    });
  });

  it('detects Cursor via versioned agent and ignores a non-Cursor agent binary', async () => {
    const cursorRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const cursorAgent = await writeScriptedJsonlExecutable(join(cursorRoot, 'agent'), {
      lines: scriptedJsonlLines('cursor', 'doctor'),
      version: 'cursor-agent 2026.08.28',
      help: 'Usage: --output-format stream-json --approve-mcps',
    });
    await writeScriptedJsonlExecutable(join(otherRoot, 'agent'), {
      lines: [],
      version: 'other 1.0.0',
      help: 'Usage: agent --not-cursor',
    });
    await withProcessEnv({ ...BIN_ENV, PATH: cursorRoot }, async () => {
      await expect(detectInstalledAgents()).resolves.toEqual([
        { kind: 'cursor', binaryPath: cursorAgent.path },
      ]);
    });
    await withProcessEnv({ ...BIN_ENV, PATH: otherRoot }, async () => {
      await expect(detectInstalledAgents()).resolves.toEqual([]);
    });
  });

  it('detects env-var absolute paths when PATH command names are missing', async () => {
    const root = await makeRoot();
    const empty = await makeRoot();
    const kimi = await writeVersionExecutable(root, 'kimi-actual', 'kimi 1.0.0');
    await withProcessEnv(
      {
        ...BIN_ENV,
        PATH: empty,
        LARK_CHANNEL_KIMI_BIN: kimi,
      },
      async () => {
        await expect(detectInstalledAgents()).resolves.toEqual([{ kind: 'kimi', binaryPath: kimi }]);
      },
    );
  });

  it.each(PINNED_AGENT_KINDS)('/doctor found versus missing binary for %s', async (kind) => {
    const found = await doctorRun(kind, 'found');
    expect(found.handled).toBe(true);
    expect(found.report).toContain(`agent: ${pinnedDisplayName(kind)} (${kind})`);
    expect(found.report).toContain('agent echo check: OK');
    expect(found.report).not.toContain('larkent doctor');

    const missing = await doctorRun(kind, 'missing');
    expect(missing.handled).toBe(true);
    expect(missing.report).toContain(`agent: ${pinnedDisplayName(kind)} (${kind})`);
    expect(missing.report).toContain(missingDoctorEchoCheck(kind));
    expect(missing.report).not.toContain('larkent doctor');
  });
});

async function doctorRun(kind: PinnedAgentKind, scenario: 'found' | 'missing'): Promise<{
  handled: boolean;
  report: string;
}> {
  const tmp = await createTmpProfile(`pin-doctor-${kind}-${scenario}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `cli_doc_${kind}`, secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-owner'] },
    ...(kind === 'codex' ? { codex: { binaryPath: '/no/such/pin-codex' } } : {}),
  });
  profileConfig.workspaces.default = tmp.workspace;
  const fake =
    scenario === 'found'
      ? await writeScriptedJsonlExecutable(join(tmp.root, 'bin', kind), {
          lines: scriptedJsonlLines(kind, 'doctor'),
          version: scriptedVersion(kind),
        })
      : undefined;
  if (kind === 'codex' && fake) {
    profileConfig.codex = { ...profileConfig.codex!, binaryPath: fake.path };
  }
  const agent =
    scenario === 'found'
      ? createPinnedAdapter(kind, fake!.path, tmp.profile)
      : createPinnedAdapter(kind, '/no/such/pin-binary', tmp.profile);
  const pool = new ProcessPool(() => 1);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => `doctor-${kind}-${scenario}`,
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });
  const controls = {
    profile: `${kind}-${scenario}`,
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: `proc-${kind}-${scenario}`,
  } satisfies Controls;
  const handled = await tryHandleCommand({
    channel: channel as unknown as CommandContext['channel'],
    msg: doctorMessage(kind, scenario),
    scope: 'chat-1',
    chatMode: 'p2p',
    sessions,
    workspaces,
    agent,
    activeRuns,
    processPool: pool,
    runExecutor: executor,
    controls,
  });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { handled, report: doctorReport(channel) };
}

function doctorMessage(kind: PinnedAgentKind, scenario: string): NormalizedMessage {
  return {
    messageId: `om-doctor-${kind}-${scenario}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-owner',
    senderName: 'Owner',
    content: '/doctor',
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function missingDoctorEchoCheck(kind: PinnedAgentKind): string {
  switch (kind) {
    case 'claude':
      return 'agent echo check: error';
    case 'codex':
    case 'kimi':
    case 'grok':
    case 'cursor':
      return 'agent echo check: failed';
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

function doctorReport(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  if (stream) {
    const latest = stream.cardUpdates.at(-1) ?? (stream.input as { card?: { initial?: unknown } }).card?.initial;
    return JSON.stringify(latest);
  }
  const content = channel.sent.at(-1)?.content as { markdown?: string; text?: string } | undefined;
  return String(content?.markdown ?? content?.text ?? JSON.stringify(channel.sent.at(-1)?.content ?? ''));
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pin-detect-'));
  roots.push(root);
  return root;
}
