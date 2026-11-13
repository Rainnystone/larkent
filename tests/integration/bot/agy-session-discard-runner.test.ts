import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityAdapter } from '../../../src/agent/antigravity/adapter';
import { CursorAdapter } from '../../../src/agent/cursor/adapter';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { log } from '../../../src/core/logger';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { agyScript, installKindCli, jsonlScript, type JsonlScript } from '../../helpers/scripted-jsonl-cli';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const CONVERSATION = '40150299-9f07-4d75-ac4e-4cc6943cf3b2';
const FRESH = 'c2bae29d-5b74-4e38-9eed-124912f29c14';
const CURSOR_SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const FRESH_SESSION_NOTICE = '下一条消息将开始新会话';
const WAIT = { timeout: 15_000 };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('agy session discard through the real runner', { timeout: 40_000 }, () => {
  it('delivers the sticky ERROR-with-answer turn cleanly and starts the next message without --conversation', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');
    await h.turn(agyScript('sticky-error', CONVERSATION, 'PONG-01'), 'follow up');
    expect(h.lastFinal()).toMatchObject({ terminal: 'done', outcome: 'completed' });
    // text-mode Outbox send is after card.final; Windows journal.flush lags that log.
    await vi.waitFor(() => {
      expect(h.text()).toContain('PONG-01');
    }, WAIT);
    expect(h.text()).not.toContain('agent 失败');
    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
    expect(h.text()).not.toContain(CONTINUE_HINT);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBeUndefined();
    expect(h.catalog.entries().filter(entry => entry.status === 'active')).toEqual([]);

    await h.turn(agyScript('success', FRESH), 'next');
    const runs = await h.runs();
    expect(runs.map(conversationFlag)).toEqual([undefined, CONVERSATION, undefined]);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBe(FRESH);
  });

  it('fails an agy ERROR without answer, says so, and starts 继续 as a fresh conversation that replays the failed request', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');
    await h.turn(agyScript('error-without-answer', CONVERSATION), 'summarise the diff');
    expect(h.lastFinal()).toMatchObject({ terminal: 'error', outcome: 'failed:unclassified' });
    await vi.waitFor(() => {
      expect(h.text()).toContain('agent 失败');
      expect(h.text()).toContain(FRESH_SESSION_NOTICE);
      expect(h.text()).toContain(CONTINUE_HINT);
    }, WAIT);
    await h.turn(agyScript('success', FRESH), '继续');
    const runs = await h.runs();
    expect(runs.map(conversationFlag)).toEqual([undefined, CONVERSATION, undefined]);
    expect(runs[2]!.join(' ')).toContain('summarise the diff');
  });

  it('keeps resuming the same conversation after an agy SUCCESS', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');
    await h.turn(agyScript('success', CONVERSATION), 'follow up');
    expect((await h.runs()).map(conversationFlag)).toEqual([undefined, CONVERSATION]);
    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
  });

  // agy 1.5.3 probe 2026-11-10: the resume right after a print timeout with an
  // open background tool succeeds and recalls the conversation.
  it('keeps the conversation after an agy print-timeout ERROR with an open background tool', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');
    await h.turn(agyScript('print-timeout-open-tool', CONVERSATION), 'run sleep 90 && echo done');
    expect(h.lastFinal()).toMatchObject({ terminal: 'error' });
    await vi.waitFor(() => expect(h.text()).toContain('agent 失败'), WAIT);
    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
    expect(h.sessions.resumeFor('oc_dm', h.cwd, 'antigravity')).toBe(CONVERSATION);
    expect(h.catalog.entries().filter(entry => entry.status === 'active').map(entry => entry.resumeHandle)).toEqual([CONVERSATION]);

    await h.turn(agyScript('success', CONVERSATION), 'next');
    expect((await h.runs()).map(conversationFlag)).toEqual([undefined, CONVERSATION, CONVERSATION]);
  });

  it('keeps a non-agy CLI error session', async () => {
    const h = await harness('cursor');
    const init = { type: 'system', subtype: 'init', cwd: h.cwd, session_id: CURSOR_SESSION, model: 'Composer 2.5' };
    const success = { lines: [init, ...jsonlScript('cursor', 'success').lines.slice(1)] };
    await h.turn(success, 'seed');
    await h.turn({ lines: [
      init, { type: 'result', subtype: 'error', is_error: true, result: 'upstream failed', session_id: CURSOR_SESSION },
    ], exitCode: 1 }, 'follow up');
    expect(h.lastFinal()).toMatchObject({ terminal: 'error' });
    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
    await h.turn(success, 'next');
    expect((await h.runs()).map(argv => resumeFlag(argv, '--resume'))).toEqual([undefined, CURSOR_SESSION, CURSOR_SESSION]);
  });

  // agy's own SIGTERM echo is result ERROR + finished_reason interrupted. The
  // fixture's SIGTERM handler cannot run on Windows (TerminateProcess).
  it.skipIf(process.platform === 'win32')('keeps the conversation when /stop interrupts agy', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');
    await h.script(agyScript('interrupted-on-sigterm', CONVERSATION));
    await h.send('long task');
    await h.ready();
    await h.send('/stop', 'om_stop');
    await vi.waitFor(() => expect(h.finals()).toHaveLength(2), WAIT);
    expect(h.lastFinal()).toMatchObject({ outcome: 'interrupted:user-stop' });
    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
    await h.turn(agyScript('success', CONVERSATION), 'next');
    expect((await h.runs()).map(conversationFlag)).toEqual([undefined, CONVERSATION, CONVERSATION]);
  });

  it('keeps the conversation when agy is killed, exits non-zero without a result, or cannot spawn', async () => {
    const h = await harness('antigravity');
    await h.turn(agyScript('success', CONVERSATION), 'seed');

    await h.script(agyScript('hold-for-kill', CONVERSATION));
    await h.send('killed');
    process.kill(Number(await h.ready()), 'SIGKILL');
    await vi.waitFor(() => expect(h.finals()).toHaveLength(2), WAIT);
    expect(h.lastFinal()).toMatchObject({ terminal: 'error' });

    await h.turn(agyScript('exit-without-result', CONVERSATION), 'exits');
    expect(h.lastFinal()).toMatchObject({ terminal: 'error' });

    await rename(h.binary, `${h.binary}.gone`);
    await h.send('no binary', 'om_spawn');
    await vi.waitFor(() => expect(h.failures()).toContain('agy binary check failed'), WAIT);
    await rename(`${h.binary}.gone`, h.binary);

    expect(h.text()).not.toContain(FRESH_SESSION_NOTICE);
    await h.turn(agyScript('success', CONVERSATION), 'next');
    expect((await h.runs()).map(conversationFlag)).toEqual([undefined, CONVERSATION, CONVERSATION, CONVERSATION]);
  });
});

async function harness(kind: 'antigravity' | 'cursor') {
  const tmp = await createTmpProfile('agy-session-discard-');
  cleanups.push(tmp.cleanup);
  const { fake } = await installKindCli(join(tmp.root, 'bin'), kind);
  const runsPath = join(tmp.root, 'runs.jsonl');
  const readyPath = join(tmp.root, 'ready');
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const cfg = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off', runIdleTimeoutMinutes: 1 },
  });
  cfg.workspaces.default = tmp.workspace;
  const agent = kind === 'antigravity'
    ? new AntigravityAdapter({ binary: fake.path, stopGraceMs: 500 })
    : new CursorAdapter({ binary: fake.path, stopGraceMs: 500 });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const info = vi.spyOn(log, 'info');
  const fail = vi.spyOn(log, 'fail');
  const bridge = await startChannel({
    cfg, agent, sessions, sessionCatalog: catalog, workspaces, journal, probe: async () => true,
    appPaths: { mediaDir, secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, '.keystore.salt') },
    controls: { profile: kind, profileConfig: cfg, cfg, botOwnerId: 'ou_user', ownerRefreshState: 'ok',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.root, 'config.json'), processId: 'agy-session-discard' },
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([journal.flush(), sessions.flush(), catalog.flush(), workspaces.flush()]);
  });
  let messages = 0;
  const finals = () => info.mock.calls
    .filter(call => call[0] === 'card' && call[1] === 'final')
    .map(call => call[2] as Record<string, unknown>);
  const script = async (next: JsonlScript) => {
    await rm(readyPath, { force: true });
    await writeFile(fake.scriptPath, JSON.stringify({ ...next, recordAppendPath: runsPath, readyPath }));
  };
  const send = async (content: string, messageId = `om_${++messages}`) => {
    await channel.handlers.message?.(message(messageId, content));
  };
  return {
    channel, sessions, catalog, finals, script, send,
    binary: fake.path,
    cwd: await realpath(tmp.workspace),
    lastFinal: () => finals().at(-1),
    failures: () => fail.mock.calls.map(call => (call[1] instanceof Error ? call[1].message : String(call[1]))),
    text: () => JSON.stringify(channel.sent),
    ready: () => vi.waitFor(() => readFile(readyPath, 'utf8'), WAIT),
    runs: async () => (await readFile(runsPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { argv: string[] }).argv),
    turn: async (next: JsonlScript, content: string) => {
      const before = finals().length;
      const sentBefore = channel.sent.length;
      await script(next);
      await send(content);
      await vi.waitFor(() => expect(finals()).toHaveLength(before + 1), WAIT);
      await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(sentBefore), WAIT);
    },
  };
}

function conversationFlag(argv: string[]): string | undefined {
  return resumeFlag(argv, '--conversation');
}

function resumeFlag(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function message(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_user', senderName: 'User',
    rawContentType: 'text', resources: [], mentionedBot: false, createTime: Date.now(),
  } as unknown as NormalizedMessage;
}
