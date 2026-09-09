import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { ResumeCandidates } from '../../../src/session/resume-candidates.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type { CodexThreadHistoryEntry } from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { listRecentSessions } from '../../../src/session/history.js';
import { listCodexThreadHistory } from '../../../src/session/codex-history.js';
import { log } from '../../../src/core/logger.js';
import { descriptorFor } from '../../../src/agent/registry.js';
import type { ResumeHistoryInput } from '../../../src/agent/definition.js';

// External boundaries stay isolated even before the unified provider is implemented.
vi.mock('../../../src/session/history.js', async (original) => ({
  ...await original<typeof import('../../../src/session/history.js')>(),
  listRecentSessions: vi.fn(async () => []),
}));
vi.mock('../../../src/session/codex-history.js', () => ({
  listCodexThreadHistory: vi.fn(async () => []),
}));
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  identity: SessionCatalogIdentity;
  claudeHistory: SessionSummary[];
  codexHistory: CodexThreadHistoryEntry[];
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
  historyInputs: ResumeHistoryInput[];
}

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware resume commands', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(listRecentSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listCodexThreadHistory).mockReset().mockResolvedValue([]);
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(['command', 'card'] as const)('rejects a different profile nonce through %s without consuming the owner candidate', async (route) => {
    const a = await createHarness('kimi');
    const b = await createHarness('kimi', { sharedWorkspace: a.tmp.workspace });
    expect(b.identity).toEqual(a.identity);
    a.sessions.set('chat-1', 'handle-a', a.identity.cwdRealpath);
    b.sessions.set('chat-1', 'handle-b', b.identity.cwdRealpath);
    b.catalog.upsertActive({ ...b.identity, resumeHandle: 'handle-b', now: 1000 });
    const beforeSession = { ...b.sessions.getRaw('chat-1') };
    const beforeCatalog = { ...b.catalog.activeFor(b.identity) };
    await a.run('/resume');
    const nonce = resumeNonce(lastMarkdown(a.channel));
    if (route === 'command') await b.run(`/resume use ${nonce}`);
    else await b.dispatchResumeArg(nonce);
    expect(b.sessions.getRaw('chat-1')).toEqual(beforeSession);
    expect(b.catalog.activeFor(b.identity)).toEqual(beforeCatalog);
    expect(lastMarkdown(b.channel)).toContain('不可恢复');
    if (route === 'command') await a.run(`/resume use ${nonce}`);
    else await a.dispatchResumeArg(nonce);
    expect(a.catalog.activeFor(a.identity)?.resumeHandle).toBe('handle-a');
    expect(lastMarkdown(a.channel)).toContain('已完成');
  });

  it('keeps migrated scoped workspace aliases ahead of legacy fallback in actual commands', async () => {
    const h = await createHarness('claude');
    const scoped = join(h.tmp.root, 'scoped');
    const legacy = join(h.tmp.root, 'legacy');
    await mkdir(scoped);
    await mkdir(legacy);
    await h.workspaces.flush();
    await writeFile(join(h.tmp.profile, 'workspaces.json'), JSON.stringify({
      chats: { 'chat-1': { cwd: h.tmp.workspace }, 'chat-1:topic-other': { cwd: legacy } },
      named: { work: legacy, 'claude\u001fou-user\u001fchat-1\u001fwork': scoped },
    }));
    await h.workspaces.load();
    await h.run('/ws use work');
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(scoped));
    expect(h.workspaces.cwdFor('chat-1:topic-other')).toBe(legacy);
    await h.run('/ws remove work');
    await h.run('/ws use work');
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(legacy));
    expect(h.workspaces.getNamed('work')).toBe(legacy);
  });

  it('rejects unknown descriptors instead of falling back to local history', () => {
    expect(() => descriptorFor('unknown' as AgentKind)).toThrow('unknown agent kind');
  });

  it.each(['kimi', 'grok', 'cursor'] as const)('keeps %s catalog resume candidates and raw current handles', async (kind) => {
    const h = await createHarness(kind);
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'session-current', now: 1000 });
    await h.run('/resume');
    expect(lastMarkdown(h.channel)).toContain('会话可恢复');
    await h.run('/resume use session-current');
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('session-current');
  });

  it('maps Claude history through its descriptor', async () => {
    const h = await createHarness('claude');
    vi.mocked(listRecentSessions).mockResolvedValueOnce([claudeSession('session-1', 'hello', 1234)]);
    const input = { profile: h.controls.profileConfig, profileDir: h.tmp.profile, cwd: h.tmp.workspace, limit: 3 };
    expect(await descriptorFor('claude').listResumeHistory(input)).toEqual([{ resumeHandle: 'session-1', preview: 'hello', updatedAtMs: 1234, lineCount: 1 }]);
    expect(listRecentSessions).toHaveBeenLastCalledWith(h.tmp.workspace, 3);
  });

  it('maps Codex history with the factory binary and profile environment', async () => {
    const h = await createHarness('codex');
    const profile = h.controls.profileConfig;
    profile.agent.binaryPath = '/fake/pinned-codex';
    profile.agent.options = { codexHome: '/fake/codex-home', inheritCodexHome: false };
    vi.mocked(listCodexThreadHistory).mockResolvedValueOnce([{ ...codexThread('thread-1', 'preview', 4321), name: 'title' }]);
    expect(await descriptorFor('codex').listResumeHistory({ profile, profileDir: h.tmp.profile, cwd: h.tmp.workspace, limit: 3 })).toEqual([{ resumeHandle: 'thread-1', preview: 'title', updatedAtMs: 4321, detail: 'Codex · exec' }]);
    expect(listCodexThreadHistory).toHaveBeenLastCalledWith({ binary: '/fake/pinned-codex', cwd: h.tmp.workspace, limit: 3, profileStateDir: h.tmp.profile, codexHome: '/fake/codex-home', inheritCodexHome: false });
  });

  it('returns no Codex history when no binary is configured', async () => {
    const h = await createHarness('codex');
    h.controls.profileConfig.agent.binaryPath = undefined;
    h.controls.profileConfig.codex = undefined;
    expect(await descriptorFor('codex').listResumeHistory({ profile: h.controls.profileConfig, profileDir: h.tmp.profile, cwd: h.tmp.workspace, limit: 5 })).toEqual([]);
    expect(listCodexThreadHistory).not.toHaveBeenCalled();
  });

  it('returns empty history with a profile-scoped error when Codex query fails', async () => {
    const h = await createHarness('codex');
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.mocked(listCodexThreadHistory).mockRejectedValueOnce(new Error('fixture query failed'));
    expect(await descriptorFor('codex').listResumeHistory({ profile: h.controls.profileConfig, profileDir: h.tmp.profile, cwd: h.tmp.workspace, limit: 5 })).toEqual([]);
    expect(warning).toHaveBeenCalledWith('session', 'codex-history-failed', { profile: h.tmp.profile, message: 'fixture query failed' });
    warning.mockRestore();
  });

  it.each(['kimi', 'grok', 'cursor'] as const)('%s does not invent external history', async kind => {
    const h = await createHarness(kind);
    expect(await descriptorFor(kind).listResumeHistory({ profile: h.controls.profileConfig, profileDir: h.tmp.profile, cwd: h.tmp.workspace, limit: 5 })).toEqual([]);
    expect(listRecentSessions).not.toHaveBeenCalled();
    expect(listCodexThreadHistory).not.toHaveBeenCalled();
  });

  it('uses the catalog current handle before the SessionStore handle', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'stale-session', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'catalog-session', now: 1000 });
    await h.run('/resume');
    await h.run(`/resume use ${resumeNonce(lastMarkdown(h.channel))}`);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('catalog-session');
  });

  it('offers the SessionStore current handle when the catalog has no entry', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'stored-session', h.identity.cwdRealpath);
    await h.run('/resume');
    await h.run(`/resume use ${resumeNonce(lastMarkdown(h.channel))}`);
    expect(h.catalog.activeFor(h.identity)?.resumeHandle).toBe('stored-session');
  });

  it.each(['claude', 'kimi', 'grok', 'cursor'] as const)('does not issue a %s candidate from a different stored cwd', async kind => {
    const h = await createHarness(kind);
    const oldCwd = join(h.tmp.profile, 'old-workspace');
    h.sessions.set('chat-1', 'old-session', oldCwd);
    const original = { ...h.sessions.getRaw('chat-1') };
    await h.run('/resume');
    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('此 cwd 下没有历史会话');
    expect(rendered).not.toContain('/resume use');
    expect(resumeArgsFromCard(lastContent(h.channel))).toEqual([]);
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.sessions.getRaw('chat-1')).toEqual(original);
  });

  it('does not upgrade a legacy SessionStore handle to a Codex thread candidate', async () => {
    const h = await createHarness('codex');
    h.sessions.set('chat-1', 'legacy-session', h.identity.cwdRealpath);
    const original = { ...h.sessions.getRaw('chat-1') };
    await h.run('/resume');
    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.sessions.getRaw('chat-1')).toEqual(original);
  });

  it('compares a stored cwd with the canonical current workspace', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'stored-session', h.identity.cwdRealpath);
    h.workspaces.setCwd('chat-1', `${h.tmp.workspace}/../workspace`);
    await h.run('/resume');
    await h.run(`/resume use ${resumeNonce(lastMarkdown(h.channel))}`);
    expect(h.catalog.activeFor(h.identity)?.resumeHandle).toBe('stored-session');
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      agentId: 'codex',
      resumeHandle: 'thread-other-agent',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.activeFor({ ...h.identity, agentId: 'codex' })).toMatchObject({
      resumeHandle: 'thread-other-agent',
    });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      resumeHandle: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected Claude history entry from the card button callback', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'sess-current', now: 1000 });
    h.claudeHistory.push(
      claudeSession('sess-current', 'current prompt', 1_700_000_100_000),
      claudeSession('sess-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('sess-tar');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe('sess-target');
    await h.dispatchResumeArg(nonces[1]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      resumeHandle: 'sess-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('accepts the current Codex thread without writing it into legacy SessionStore', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const failure = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'thread-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(failure).toHaveBeenCalled();
    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only the current catalog-backed Codex thread in /resume', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Codex thread 可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
    expect(lastMarkdown(h.channel)).not.toContain('thread-current');
  });

  it('does not accept raw Codex thread ids as resume candidates', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'thread-current', now: 1000 });

    await expect(h.run('/resume use thread-current')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
  });

  it('does not fall back to legacy SessionStore when Codex catalog identity is missing', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume use thread-current', { withCatalogIdentity: false })).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前上下文没有可恢复的 Codex thread');
  });

  it('does not list Claude local history for Codex when no current thread is recorded', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists Codex history for the current cwd and resumes the selected thread through a nonce', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      codexThread('thread-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
    expect(rendered).not.toContain('thread-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      resumeHandle: 'thread-beta-secret',
    });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes a Codex history selection from the card button callback', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      resumeHandle: 'thread-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('keeps Codex resume history details out of group chats like Claude', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
  });

  it('labels Codex status as session while reading the recorded thread id', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('未建立');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.catalog.upsertActive({ ...h.identity, resumeHandle: 'thread-current', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('thread-c');
    expect(status).not.toContain('未建立');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness('claude', { bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });

  it('lists Codex history with agent.binaryPath when it differs from nested codex.binaryPath', async () => {
    const h = await createHarness('codex');
    h.controls.profileConfig.agent = { kind: 'codex', binaryPath: '/opt/pinned/codex-a' };
    if (h.controls.profileConfig.codex) {
      h.controls.profileConfig.codex = {
        ...h.controls.profileConfig.codex,
        binaryPath: '/opt/pinned/codex-b',
      };
    }

    await expect(h.run('/resume')).resolves.toBe(true);
    expect(h.historyInputs).toHaveLength(1);
    expect(h.historyInputs[0]).toMatchObject({ profile: h.controls.profileConfig, profileDir: join(h.tmp.profile, 'profiles', 'codex'), cwd: h.tmp.workspace, limit: 5 });
  });
});

async function createHarness(
  agentKind: AgentKind,
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean; sharedWorkspace?: string } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile(`resume-command-${agentKind}-`);
  const cwd = options.sharedWorkspace ?? tmp.workspace;
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const claudeHistory: SessionSummary[] = [];
  const codexHistory: CodexThreadHistoryEntry[] = [];
  const historyInputs: ResumeHistoryInput[] = [];
  const activeRuns = new ActiveRuns();
  const resumeCandidates = new ResumeCandidates();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig(agentKind);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = cwd;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', cwd);
  }
  const identity = await commandIdentity(agentKind, profileConfig, controls, cwd);
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      resumeCandidates,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      resumeHistoryProvider: async (input) => {
        historyInputs.push(input);
        return agentKind === 'codex'
          ? codexHistory.map(t => ({ resumeHandle: t.threadId, preview: t.name || t.preview, updatedAtMs: t.updatedAtMs, detail: `Codex · ${t.source}` }))
          : claudeHistory.map(t => ({ resumeHandle: t.sessionId, preview: t.preview, updatedAtMs: t.mtime, lineCount: t.lineCount }));
      },
    });

  const dispatchResumeArg = (arg: string): Promise<void> =>
    handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.use', arg }),
      sessions,
      resumeCandidates,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
    });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    controls,
    identity,
    claudeHistory,
    codexHistory,
    activeRuns,
    pending,
    run,
    dispatchResumeArg,
    historyInputs,
  };
}

function claudeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): SessionSummary {
  return {
    sessionId,
    preview,
    mtime,
    lineCount: 1,
  };
}

async function commandIdentity(
  agentKind: AgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = descriptorFor(agentKind).capability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: 'chat-1',
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(agentKind: AgentKind): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeNonce(markdown: string): string {
  const match = markdown.match(/\/resume use ([a-f0-9-]+)/);
  const nonce = match?.[1];
  expect(nonce).toBeTypeOf('string');
  if (!nonce) throw new Error('missing resume nonce');
  return nonce;
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}

function codexThread(
  threadId: string,
  preview: string,
  updatedAtMs: number,
): CodexThreadHistoryEntry {
  return {
    threadId,
    sessionId: threadId,
    preview,
    cwd: '/tmp/workspace',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source: 'exec',
  };
}
