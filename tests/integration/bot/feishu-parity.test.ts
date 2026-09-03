import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime.js';
import { createRecordingLarkChannel, type RecordingCall } from '../../helpers/recording-lark-channel.js';
import {
  PIN_AGENT_KINDS,
  envBinVarName,
  installKindCli,
  jsonlScript,
  pinAgentKind,
  stabilizePinSnapshot,
  writeJsonlScriptFile,
  type PinAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('recording channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];
const goldenRoot = join(process.cwd(), 'tests/fixtures/goldens/feishu-parity');
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  restoreEnv();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('P1 Feishu surface parity', () => {
  it.each(PIN_AGENT_KINDS)('pins the bot channel-call sequence for %s', async (kind) => {
    const pinned = pinAgentKind(kind);
    const h = await startParityBot(pinned);

    await writeFile(h.scriptFile, `${JSON.stringify(jsonlScript(pinned, 'error'))}\n`);
    await h.channel.handlers.message?.(p2pMessage('om_error', 'please fail'));
    await waitFor(() => snapshotHasError(h.channel.snapshotCalls()), 12_000);
    const errorCalls = stabilizeCalls(h.channel.snapshotCalls(), h.cwd);

    h.channel.callLog.length = 0;
    h.channel.sent.length = 0;
    h.channel.streams.length = 0;

    await writeFile(h.scriptFile, `${JSON.stringify(jsonlScript(pinned, 'success'))}\n`);
    await h.channel.handlers.message?.(p2pMessage('om_success', 'please succeed'));
    await waitFor(() => snapshotHasAnswer(h.channel.snapshotCalls()), 12_000);
    const successCalls = stabilizeCalls(h.channel.snapshotCalls(), h.cwd);

    if (pinned === 'grok') {
      const record = JSON.parse(await readFile(h.recordPath, 'utf8')) as { argv: string[] };
      expect(record.argv).toContain('streaming-json');
      expect(record.argv).not.toContain('stream-json');
    }

    await expectGolden(join(goldenRoot, `${pinned}.json`), { success: successCalls, error: errorCalls });
  }, 60_000);
});

async function startParityBot(kind: PinAgentKind): Promise<{
  channel: ReturnType<typeof createRecordingLarkChannel>;
  cwd: string;
  scriptFile: string;
  recordPath: string;
}> {
  const tmp = await createTmpProfile(`feishu-parity-${kind}-`);
  const cwd = await realpath(tmp.workspace);
  const binDir = join(tmp.root, 'bin');
  const installed = await installKindCli(binDir, kind);
  const scriptFile = await writeJsonlScriptFile(join(tmp.root, 'scripts'), jsonlScript(kind, 'success'));
  setEnv('LARKENT_FAKE_JSONL', scriptFile);
  setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
  if (kind !== 'claude' && kind !== 'codex') {
    setEnv(envBinVarName(kind), installed.fake.path);
  } else {
    setEnv(envBinVarName(kind), undefined);
  }
  if (kind === 'cursor') setEnv('LARK_CHANNEL_CURSOR_BIN', installed.fake.path);

  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `cli_${kind}`, secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card' },
    ...(kind === 'codex'
      ? { codex: { binaryPath: installed.fake.path, inheritCodexHome: false } }
      : {}),
  });
  profileConfig.workspaces.default = cwd;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(`${join(tmp.profile, 'sessions.json')}.catalog.json`);
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = createRuntimeAgent(profileConfig, {
    profileDir: tmp.profile,
    profile: kind,
    rootDir: tmp.root,
    configFile: join(tmp.root, 'config.json'),
  });
  const channel = createRecordingLarkChannel();
  sdkMock.channel = channel;
  const controls = {
    profile: kind,
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc_pin',
  };
  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    sessionCatalog: catalog,
    workspaces,
    controls,
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, cwd, scriptFile, recordPath: installed.fake.recordPath };
}

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

function p2pMessage(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function snapshotHasError(calls: RecordingCall[]): boolean {
  const blob = JSON.stringify(calls);
  return blob.includes('PINNED_ERROR') || blob.includes('exited with code 1') || blob.includes('agent 失败');
}

function snapshotHasAnswer(calls: RecordingCall[]): boolean {
  return JSON.stringify(calls).includes('PINNED_ANSWER');
}

function stabilizeCalls(calls: RecordingCall[], cwd: string): unknown {
  return stabilizePinSnapshot(calls, [
    [cwd, '<cwd>'],
    [process.cwd(), '<repo>'],
  ]);
}

async function expectGolden(path: string, actual: unknown): Promise<void> {
  if (process.env.UPDATE_PIN_GOLDENS === '1') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(await readFile(path, 'utf8')) as unknown;
  expect(actual).toEqual(expected);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for Feishu parity sequence');
}
