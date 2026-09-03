import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { CodexThreadHistoryEntry } from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import {
  PINNED_AGENT_KINDS,
  assertGoldenFile,
  pinnedDisplayName,
  sanitizePinValue,
  type PinnedAgentKind,
} from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('P5 slash command parity', () => {
  it('does not register /history or /model as slash handlers', async () => {
    const source = await readFile(join(process.cwd(), 'src/commands/index.ts'), 'utf8');
    const handlersStart = source.indexOf('const handlers:');
    const handlersEnd = source.indexOf('};', handlersStart);
    const handlers = source.slice(handlersStart, handlersEnd);
    expect(handlers).toContain("'/resume': handleResume");
    expect(handlers).toContain("'/status': handleStatus");
    expect(handlers).not.toContain("'/history'");
    expect(handlers).not.toContain("'/model'");
  });

  it.each(PINNED_AGENT_KINDS)('snapshots /resume and /status for %s', async (kind) => {
    const h = await createHarness(kind);
    const resumeHandled = await h.run('/resume');
    const resumeSent = snapshotSent(h.channel);
    const statusHandled = await h.run('/status');
    const statusSent = snapshotSent(h.channel, resumeSent.length);
    const historyHandled = await h.run('/history');
    const modelHandled = await h.run('/model');

    expect(resumeHandled).toBe(true);
    expect(statusHandled).toBe(true);
    expect(historyHandled).toBe(false);
    expect(modelHandled).toBe(false);
    expect(h.channel.sent).toHaveLength(resumeSent.length + statusSent.length);

    assertGoldenFile(join(process.cwd(), 'tests/fixtures/goldens/slash', `${kind}.json`), {
      kind,
      resume: { handled: resumeHandled, sent: sanitizePinValue(resumeSent, [[h.tmp.root, '<tmp-root>']]) },
      status: { handled: statusHandled, sent: sanitizePinValue(statusSent, [[h.tmp.root, '<tmp-root>']]) },
      history: { handled: historyHandled },
      model: { handled: modelHandled },
    });
  });
});

async function createHarness(kind: PinnedAgentKind): Promise<{
  tmp: TmpProfile;
  channel: FakeChannel;
  run(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile(`slash-parity-${kind}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.catalog.json'));
  const agent = new FakeAgentAdapter({
    id: kind,
    displayName: pinnedDisplayName(kind),
  });
  const profileConfig = appConfig(kind, tmp.workspace);
  workspaces.setCwd('chat-1', tmp.workspace);
  const controls = {
    profile: kind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const identity = await commandIdentity(kind, profileConfig, controls, tmp.workspace);
  if (kind === 'codex') {
    catalog.upsertActive({ ...identity, threadId: 'thread-v1-codex', now: 1_700_000_000_000 });
  } else {
    catalog.upsertActive({ ...identity, sessionId: `sess-v1-${kind}`, now: 1_700_000_000_000 });
    sessions.set('chat-1', `sess-v1-${kind}`, identity.cwdRealpath);
  }
  const claudeHistory: SessionSummary[] = [
    {
      sessionId: 'sess-v1-claude',
      preview: 'pin resume preview',
      mtime: Date.now() - 2 * 60 * 60 * 1000,
      lineCount: 3,
    },
  ];
  const codexHistory: CodexThreadHistoryEntry[] = [
    {
      threadId: 'thread-v1-codex',
      sessionId: 'thread-v1-codex',
      preview: 'pin resume preview',
      cwd: '/tmp/workspace',
      createdAtMs: Date.now() - 2 * 60 * 60 * 1000 - 1000,
      updatedAtMs: Date.now() - 2 * 60 * 60 * 1000,
      source: 'exec',
      name: 'pin thread',
    },
  ];
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
      claudeHistoryProvider: async () => claudeHistory,
      codexHistoryProvider: async () => codexHistory,
    });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, run };
}

function appConfig(kind: PinnedAgentKind, workspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `cli_slash_${kind}`, secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(kind === 'codex' ? { codex: { binaryPath: '/opt/pin/codex' } } : {}),
  });
  config.workspaces.default = workspace;
  return config;
}

async function commandIdentity(
  kind: PinnedAgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = capabilityForProfile(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou-user' },
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
    messageId: `om-slash-${content.replace(/\W+/g, '-')}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function snapshotSent(channel: FakeChannel, from = 0): unknown[] {
  return channel.sent.slice(from);
}
