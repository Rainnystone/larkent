import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { expect, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../src/agent/types';
import { AutomationsStore } from '../../src/automations/store';
import { startChannel } from '../../src/bot/channel';
import { TurnJournal } from '../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { SessionStore } from '../../src/session/store';
import { WorkspaceStore } from '../../src/workspace/store';
import { createRecordingLarkChannel, type RecordingLarkChannel } from './recording-lark-channel';
import { createTmpProfile } from './tmp-profile';
import type { buildToolProcess } from './bridge-tool-process';

type Call = (operation: string, params?: object) => Promise<any>;

/** Public startChannel chain, with a controlled external runtime that consumes actual client responses. */
export async function createAutomationToolHarness({ client, cleanup, setChannel, initialNow, chatMode = 'group', agentTasks = false, journalMaxEntries, setup, agentKind = 'codex', initialMessages = [] }: {
  client: Awaited<ReturnType<typeof buildToolProcess>>;
  cleanup: Array<() => Promise<unknown>>;
  setChannel(channel: RecordingLarkChannel): void;
  initialNow: number;
  chatMode?: 'group' | 'topic';
  agentTasks?: boolean;
  journalMaxEntries?: number;
  agentKind?: 'codex' | 'claude';
  initialMessages?: unknown[];
  setup?: (tmp: Awaited<ReturnType<typeof createTmpProfile>>) => Promise<void>;
}) {
  const tmp = await createTmpProfile('automation-tools-'); cleanup.push(tmp.cleanup);
  await setup?.(tmp);
  let now = initialNow;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now); cleanup.push(async () => { clock.mockRestore(); });
  const cfg = createDefaultProfileConfig({ agentKind, codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false }, accounts: { app: { id: 'cli_bot', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_synthetic', 'ou_mate'], allowedChats: ['oc_synthetic', 'oc_other'] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' } });
  cfg.automations = { enabled: true, agentTasks, timezone: 'Asia/Shanghai' }; cfg.workspaces.default = tmp.workspace;
  const makeStore = () => new AutomationsStore({ path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => now });
  let store = makeStore(); await store.load();
  const journal = new TurnJournal(join(tmp.profile, 'journal.json'), { now: () => now, maxEntries: journalMaxEntries }); await journal.load();
  const makeChannel = (messages: unknown[] = []) => createRecordingLarkChannel({ chats: [{ id: 'oc_synthetic', name: 'Synthetic' }], chatMode, messagesByChat: messages.length ? { oc_synthetic: messages } : {} });
  let channel = makeChannel(initialMessages); setChannel(channel);
  let script: (call: Call, opts: AgentRunOptions, stopped: Promise<void>) => Promise<void | string | AgentEvent[]> = async () => {};
  let failure: unknown; let runCount = 0;
  const agent: AgentAdapter = { id: agentKind, displayName: 'Controlled runtime', isAvailable: async () => true, run(opts) {
    let stop!: () => void; const stopped = new Promise<void>(resolve => { stop = resolve; });
    return { runId: opts.runId, stop: async () => { stop(); }, waitForExit: async () => true, events: (async function* (): AsyncIterable<AgentEvent> {
      let answer: void | string | AgentEvent[];
      try { answer = await script(async (operation, params = {}) => {
        const result = await client.call({ version: 1, operation, params }, opts.toolEnv);
        expect(result.code).toBe(0); expect(result.stderr).toBe(''); return JSON.parse(result.stdout);
      }, opts, stopped); } catch (error) { failure = error; }
      runCount++;
      if (Array.isArray(answer!)) { yield* answer!; return; }
      const content = answer! ?? `Synthetic turn ${runCount} completed`;
      yield agentKind === 'claude' ? { type: 'text', delta: content } : { type: 'final_text', content };
      yield { type: 'done', terminationReason: 'normal' };
    })() };
  } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json')); await sessions.load();
  let profile = 'synthetic';
  const start = () => startChannel({ cfg, agent, sessions, workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), automations: store, journal, now: () => now, probe: async () => true,
    appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
    controls: { profile, profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-reminders' } });
  let bridge = await start();
  cleanup.push(() => bridge.disconnect());
  let message = 0;
  return { tmp, cfg, setScript(next: typeof script) { script = next; failure = undefined; }, checkFailure() { if (failure) throw failure; }, get store() { return store; }, journal, get channel() { return channel; }, get bridge() { return bridge; },
    async restart(options: { profile?: string; messages?: unknown[] } = {}) {
      const listed = await channel.rawClient.im.v1.message.list({ params: { container_id_type: 'chat', container_id: 'oc_synthetic', page_size: 100 } }) as { data: { items: unknown[] } };
      let stopError: unknown;
      try { await bridge.disconnect(); } catch (error) { stopError = error; }
      if (options.profile) profile = options.profile;
      store = makeStore(); await store.load(); await journal.load(); await sessions.load();
      channel = makeChannel(options.messages ?? listed.data.items); setChannel(channel);
      bridge = await start(); return stopError;
    },
    async command(content: string) {
      await channel.handlers.message?.({ messageId: `om_command_${++message}`, content, chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
    },
    setNow: (value: number) => { now = value; },
    /** A virtual clock jump must include the fresh socket evidence required after a tick gap. */
    async advanceConnectedTo(value: number) {
      now = value;
      await bridge.tickLink();
      bridge.noteLinkFrame();
      await bridge.tickLink();
    },
    async turn(next: typeof script, chatId = 'oc_synthetic', waitReply = true, chatType: 'group' | 'p2p' = 'group', replyTo?: string) {
      script = next; const count = runCount; failure = undefined;
      await channel.handlers.message?.({ messageId: `om_synthetic_${++message}`, content: '今天、明天、后天每天 09:00 提醒', chatId, chatType, ...(chatMode === 'topic' ? { threadId: 'omt_synthetic' } : {}), ...(replyTo ? { threadId: replyTo, rootId: replyTo, replyToMessageId: replyTo } : {}), senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
      await vi.waitFor(() => expect(runCount).toBeGreaterThan(count), { timeout: 25000 });
      if (failure) throw failure;
      if (waitReply) await vi.waitFor(() => expect(channel.sent.some(item => JSON.stringify(item.content).includes(`Synthetic turn ${runCount} completed`))).toBe(true), { timeout: 12000 });
      if (failure) throw failure;
    },
  };
}
export function automationButton(card: unknown, cmd: string): Record<string, string> {
  if (card && typeof card === 'object') {
    const object = card as Record<string, any>;
    if (object.value?.cmd === cmd) return object.value;
    for (const value of Object.values(object)) { try { return automationButton(value, cmd); } catch {} }
  }
  throw new Error(`button ${cmd} not found`);
}
export function automationClick(messageId: string, value: object, extra = {}) {
  return { messageId, chatId: 'oc_synthetic', operator: { openId: 'ou_mate' }, action: { tag: 'button', value, ...extra } } as unknown as CardActionEvent;
}
