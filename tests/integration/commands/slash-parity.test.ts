import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { capabilityForProfile } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import {
  PIN_AGENT_KINDS,
  adapterDisplayName,
  pinAgentKind,
  stabilizePinSnapshot,
  type PinAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];
const goldenRoot = join(process.cwd(), 'tests/fixtures/goldens/slash');

describe('P5 slash command parity', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(PIN_AGENT_KINDS)('snapshots /resume /status /history /model text for %s', async (kind) => {
    const pinned = pinAgentKind(kind);
    const h = await createHarness(pinned);
    const cwd = await realpath(h.tmp.workspace);
    const snapshot: Record<string, unknown> = {};

    for (const command of ['/resume', '/status', '/history', '/model'] as const) {
      h.channel.sent.length = 0;
      h.channel.streams.length = 0;
      const handled = await h.run(command);
      snapshot[command] = stabilizePinSnapshot(
        {
          handled,
          sent: h.channel.sent.map((item) => item.content),
          streams: h.channel.streams,
        },
        [[cwd, '<cwd>']],
      );
    }

    await expectGolden(join(goldenRoot, `${pinned}.json`), snapshot);
  });
});

async function createHarness(kind: PinAgentKind): Promise<{
  tmp: TmpProfile;
  channel: FakeChannel;
  run(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile(`slash-parity-${kind}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.catalog.json'));
  const workspaceRealpath = await realpath(tmp.workspace);
  workspaces.setCwd('chat-1', workspaceRealpath);
  const agent = new FakeAgentAdapter({
    id: kind,
    displayName: adapterDisplayName(kind),
  });
  const profileConfig = appConfig(kind, workspaceRealpath);
  const controls = {
    profile: kind,
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const identity = await catalogIdentity(profileConfig, controls, workspaceRealpath);
  if (kind === 'codex') {
    catalog.upsertActive({ ...identity, threadId: 'thread-slash-codex', now: 1_700_000_000_000 });
  } else {
    catalog.upsertActive({ ...identity, sessionId: `sess-slash-${kind}`, now: 1_700_000_000_000 });
    sessions.set('chat-1', `sess-slash-${kind}`, workspaceRealpath);
  }
  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: identity,
      workspaces,
      agent,
      activeRuns: new ActiveRuns(),
      controls,
      claudeHistoryProvider: async () => [
        {
          sessionId: 'sess-slash-claude',
          preview: 'pinned preview',
          mtime: Date.now(),
          lineCount: 3,
        },
      ],
      codexHistoryProvider: async () => [
        {
          threadId: 'thread-slash-codex',
          name: 'pinned thread',
          preview: 'pinned preview',
          cwd: workspaceRealpath,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          source: 'session_index',
        },
      ],
    });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, run };
}

function appConfig(kind: PinAgentKind, workspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    larkCli: { identityPreset: 'bot-only' },
    ...(kind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex', inheritCodexHome: false } } : {}),
  });
  config.workspaces.default = workspace;
  return config;
}

async function catalogIdentity(
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = capabilityForProfile(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-admin');
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou-admin' },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: 1_700_000_000_000,
    codexHome: profileConfig.codex?.codexHome,
    inheritCodexHome: profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 24)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
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
