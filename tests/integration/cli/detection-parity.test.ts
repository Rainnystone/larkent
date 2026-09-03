import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { CursorAdapter } from '../../../src/agent/cursor/adapter.js';
import { GrokAdapter } from '../../../src/agent/grok/adapter.js';
import { KimiAdapter } from '../../../src/agent/kimi/adapter.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';
import {
  PIN_AGENT_KINDS,
  adapterDisplayName,
  cursorVersionedHelpText,
  pinAgentKind,
  withEnvBin,
  withPathPrefix,
  type PinAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('P7 preflight and detection', () => {
  it('has no larkent doctor CLI and no doctor subcommand', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin).not.toHaveProperty('larkent');
    const cli = readFileSync(join(process.cwd(), 'src/cli/index.ts'), 'utf8');
    expect(cli).not.toMatch(/\.command\(\s*['"]doctor['"]\s*\)/);
    expect(readdirSync(join(process.cwd(), 'src/cli/commands'))).not.toContain('doctor.ts');
  });

  it('detects found vs missing binaries for a scripted PATH including a Cursor versioned agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-detect-path-'));
    const grok = await writeVersionExecutable(dir, 'grok', 'grok 0.0.0-pin');
    const claude = await writeVersionExecutable(dir, 'claude', 'claude 0.0.0-pin');
    const agent = await writeVersionExecutable(dir, 'agent', 'cursor-agent 2026.08.28-pin');
    expect(cursorVersionedHelpText()).toContain('stream-json');

    await withEnvBin('grok', undefined, async () => {
      await withEnvBin('claude', undefined, async () => {
        await withEnvBin('codex', undefined, async () => {
          await withEnvBin('kimi', undefined, async () => {
            await withEnvBin('cursor', undefined, async () => {
              await withPathPrefix(dir, async () => {
                await expect(detectInstalledAgents()).resolves.toEqual([
                  { kind: 'grok', binaryPath: grok },
                  { kind: 'claude', binaryPath: claude },
                  { kind: 'cursor', binaryPath: agent },
                ]);
              });
            });
          });
        });
      });
    });
  });

  it('honors LARK_CHANNEL_*_BIN over PATH names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pin-detect-env-'));
    const kimi = await writeVersionExecutable(dir, 'kimi-custom', 'kimi 0.0.0-pin');
    await withEnvBin('kimi', kimi, async () => {
      await withEnvBin('grok', 'missing-grok', async () => {
        await withEnvBin('claude', 'missing-claude', async () => {
          await withEnvBin('codex', 'missing-codex', async () => {
            await withEnvBin('cursor', 'missing-cursor', async () => {
              await withPathPrefix(dir, async () => {
                await expect(detectInstalledAgents()).resolves.toEqual([
                  { kind: 'kimi', binaryPath: kimi },
                ]);
              });
            });
          });
        });
      });
    });
  });

  it.each(PIN_AGENT_KINDS)('slash /doctor reports a found binary echo for %s', async (kind) => {
    const pinned = pinAgentKind(kind);
    const h = await createDoctorHarness(pinned, 'found');
    await expect(h.run('/doctor')).resolves.toBe(true);
    const output = lastDoctorText(h.channel);
    expect(output).toContain('self-check: ok');
    expect(output).toContain(`agent: ${adapterDisplayName(pinned)} (${pinned})`);
    expect(output).toContain('agent echo check: OK');
    expect(output).not.toContain('agent echo check: failed');
  }, 20_000);

  it.each(PIN_AGENT_KINDS)('slash /doctor reports a missing binary echo for %s', async (kind) => {
    const pinned = pinAgentKind(kind);
    const h = await createDoctorHarness(pinned, 'missing');
    await expect(h.run('/doctor')).resolves.toBe(true);
    const output = lastDoctorText(h.channel);
    expect(output).toContain('self-check: ok');
    expect(output).toContain(`agent: ${adapterDisplayName(pinned)} (${pinned})`);
    expect(output).toContain(`agent echo check: ${missingDoctorEchoCheck(pinned)}`);
    expect(output).not.toContain('agent echo check: OK');
  }, 20_000);
});

async function createDoctorHarness(
  kind: PinAgentKind,
  mode: 'found' | 'missing',
): Promise<{
  channel: FakeChannel;
  run(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile(`doctor-parity-${kind}-${mode}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const operator = `ou-${kind}-${mode}`;
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `app-${kind}-${mode}`, secret: 'secret', tenant: 'feishu' } },
    access: { admins: [operator] },
    larkCli: { identityPreset: 'bot-only' },
    ...(kind === 'codex' ? { codex: { binaryPath: '/missing/codex', inheritCodexHome: false } } : {}),
  });
  profileConfig.workspaces.default = tmp.workspace;
  const agent =
    mode === 'found'
      ? new FakeAgentAdapter({
          id: kind,
          displayName: adapterDisplayName(kind),
          events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
        })
      : missingAdapter(kind);
  const controls = {
    profile: `${kind}-${mode}-${Date.now()}`,
    profileConfig,
    botOwnerId: operator,
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });
  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, `${kind}-${mode}`),
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
  return { channel, run };
}

function missingAdapter(kind: PinAgentKind) {
  const missing = join(tmpdir(), `missing-${kind}-${Date.now()}`);
  switch (pinAgentKind(kind)) {
    case 'claude':
      return new ClaudeAdapter({ binary: missing });
    case 'codex':
      return new CodexAdapter({
        binary: missing,
        profileStateDir: tmpdir(),
        inheritCodexHome: false,
      });
    case 'kimi':
      return new KimiAdapter({ binary: missing });
    case 'grok':
      return new GrokAdapter({ binary: missing });
    case 'cursor':
      return new CursorAdapter({ binary: missing });
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

function message(content: string, senderSuffix: string): NormalizedMessage {
  return {
    messageId: `om-${senderSuffix}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: `ou-${senderSuffix}`,
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastDoctorText(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  if (stream?.cardUpdates.length) {
    return JSON.stringify(stream.cardUpdates.at(-1));
  }
  const sent = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  return sent?.markdown ?? JSON.stringify(channel.sent.at(-1)?.content ?? stream ?? null);
}

function missingDoctorEchoCheck(kind: PinAgentKind): string {
  switch (pinAgentKind(kind)) {
    case 'claude':
      return 'error';
    case 'codex':
    case 'kimi':
    case 'grok':
    case 'cursor':
      return 'failed';
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}
