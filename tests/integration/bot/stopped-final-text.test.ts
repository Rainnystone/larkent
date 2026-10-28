import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { AutomationsStore } from '../../../src/automations/store';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { VcRequestClient } from '../../../src/meeting/api';
import { answerInMeeting, attachMeetingAgent, meetingScopeId } from '../../../src/meeting/orchestrator';
import { MeetingSession } from '../../../src/meeting/session';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const ANSWER = 'BUFFERED_STOP_ANSWER_尾声';
const CHAT = 'oc_stop_test';
const USER = 'ou_stop_test';
const NOW = Date.UTC(2026, 9, 20);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe.each(['grok', 'codex'] as const)('%s stopped final text through real callers', { timeout: 20000 }, cli => {
  it('posts the buffered answer exactly once when the user sends /stop', async () => {
    const h = await harness({ cli });
    await h.channel.handlers.message?.(message('om_run', 'start'));
    await h.ready();
    await h.channel.handlers.message?.(message('om_stop', '/stop'));
    await vi.waitFor(() => expect(h.bodies().filter(body => body.includes(ANSWER))).toEqual([expect.stringContaining(ANSWER)]), { timeout: 10000 });
    await h.bridge.disconnect();
    expect(h.bodies().join('\n').split(ANSWER)).toHaveLength(2);
  });

  it('suppresses the same buffered answer when the bridge shuts down', async () => {
    const h = await harness({ cli });
    await h.channel.handlers.message?.(message('om_run', 'start'));
    await h.ready();
    await h.bridge.disconnect();
    expect(h.bodies().join('\n')).not.toContain(ANSWER);
  });

  it('suppresses the buffered answer in both destinations when a participant stops the meeting run', async () => {
    const h = await harness({ cli });
    const meetingMessages: string[] = [];
    const client: VcRequestClient = { request: async input => {
      if (input.url.endsWith('/message')) meetingMessages.push((input.data as { content: string }).content);
      return { code: 0, data: {} } as never;
    } };
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: h.agent, activeRuns, pool: new ProcessPool(() => 1) });
    const session = new MeetingSession({ client, meetingId: '70001', meetingNo: '123456789',
      originChatId: CHAT, joinedWithAccessCheck: true, config: { ...h.cfg.meeting, enabled: true } });
    h.cfg.meeting.respondIn = 'both';
    h.cfg.meeting.trigger = '@bot';
    const deps = { session, channel: h.bridge.channel, activeRuns, executor, sessions: h.sessions, workspaces: h.workspaces,
      controls: h.controls };
    attachMeetingAgent(deps);
    const answering = answerInMeeting(deps, 'start', { deliver: 'broadcast', actorId: USER });
    cleanups.push(async () => { await activeRuns.stopAll({ type: 'meeting' }); await answering; });
    await h.ready();
    const handle = activeRuns.get(meetingScopeId(session.meetingId));
    session.ingest({ event_id: 'stop-event', activity_event_type: 'chat_received',
      chat_received_items: [{ sender: { open_id: USER }, content: '@bot stop' }] });
    expect(handle?.stopRequest).toEqual({ type: 'meeting' });
    expect(await answering).toBe('');
    expect(meetingMessages).toEqual(['已中断当前任务。']);
    expect(h.bodies().join('\n')).not.toContain(ANSWER);
  });

  it('pauses a scheduled task and posts only the guard notice after a forbidden tool event', async () => {
    const h = await harness({ cli, automatic: 'guard' });
    await vi.waitFor(() => expect(h.store.get(1)).toMatchObject({ paused: true, lastStatus: 'failed' }), { timeout: 10000 });
    expect(h.bodies().join('\n')).toContain('策略拦截');
    expect(h.bodies().join('\n')).not.toContain(ANSWER);
    expect(h.journal.list().find(entry => entry.scope.startsWith('auto:'))?.outcome).toMatchObject({
      kind: 'interrupted', reason: { type: 'policy-guard', code: 'auth-config' },
    });
  });
});

async function harness(options: { cli: 'grok' | 'codex'; automatic?: 'guard' }) {
  const tmp = await createTmpProfile('stopped-final-text-');
  cleanups.push(tmp.cleanup);
  const readyPath = join(tmp.root, 'written');
  const binary = join(tmp.root, 'buffered-cli.mjs');
  const guard = options.automatic === 'guard';
  // This executable speaks the real CLI protocol but never executes its tool
  // descriptions. The write callback acknowledges bytes in the OS pipe before
  // /stop; the runner must drain those bytes even if parsing follows the signal.
  const lines = options.cli === 'grok'
    ? [
      { type: 'text', data: ANSWER },
      ...(guard ? [{ type: 'tool_call', toolCallId: 'blocked', toolName: 'Bash', status: 'in_progress', rawInput: { command: 'lark-cli auth logout' } }] : []),
    ]
    : [
      { type: 'thread.started', thread_id: 'synthetic-stop-thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: ANSWER } },
      ...(guard ? [{ type: 'item.started', item: { id: 'blocked', type: 'command_execution', command: 'lark-cli auth logout' } }] : []),
    ];
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: buffered CLI fixture'); process.exit(0); }
process.stdin.resume();
process.stdout.write(${JSON.stringify(lines.map(line => JSON.stringify(line)).join('\n') + '\n')}, () => writeFileSync(${JSON.stringify(readyPath)}, 'written'));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const agent = options.cli === 'grok'
    ? new GrokAdapter({ binary, stopGraceMs: 500 })
    : new CodexAdapter({ binary, profileStateDir: tmp.profile, inheritCodexHome: false, stopGraceMs: 500 });
  const cfg = createDefaultProfileConfig({
    agentKind: options.cli,
    ...(options.cli === 'codex' ? { codex: { binaryPath: binary } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: { messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off', showToolCalls: false,
      runIdleTimeoutMinutes: 1 },
  });
  cfg.workspaces.default = tmp.workspace;
  cfg.automations = { enabled: true, agentTasks: true, timezone: 'UTC' };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const store = new AutomationsStore({ journal, path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'), now: () => NOW });
  await store.load();
  if (options.automatic) await store.create({
    taskType: 'agent', schedule: { kind: 'interval', everyMs: 3600000, startAt: NOW, endAt: NOW + 7200000, timezone: 'UTC' }, timezone: 'UTC',
    startAt: NOW, endAt: NOW + 3600000, nextFireAt: NOW,
    chatId: CHAT, createdBy: USER, name: 'buffered task', taskText: 'start', cwd: tmp.workspace,
  });
  const channel = createRecordingLarkChannel({ chats: [{ id: CHAT, name: 'Synthetic stop test' }] });
  sdk.channel = channel;
  const controls = { profile: 'stop-test', profileConfig: cfg, cfg, botOwnerId: USER, ownerRefreshState: 'ok' as const,
    async refreshOwner() {}, async restart() {}, async exit() {},
    configPath: join(tmp.root, 'config.json'), processId: 'stop-test' };
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces, journal, automations: store, now: () => NOW, probe: async () => true, controls,
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([journal.flush(), store.flush(), sessions.flush(), workspaces.flush()]);
  });
  return {
    bridge, channel, journal, store, cfg, agent, sessions, workspaces, controls,
    ready: () => vi.waitFor(async () => expect(await readFile(readyPath, 'utf8')).toBe('written'), { timeout: 10000 }),
    bodies: () => channel.sent.map(row => {
      const content = row.content as { text?: string; markdown?: string };
      return content.text ?? content.markdown ?? JSON.stringify(row.content);
    }),
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return { messageId, content, chatId: CHAT, chatType: 'p2p', senderId: USER,
    senderName: 'Synthetic user', rawContentType: 'text', resources: [], mentionedBot: false, createTime: NOW,
  } as unknown as NormalizedMessage;
}
