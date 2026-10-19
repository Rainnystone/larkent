import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import { AutomationsStore } from '../../../src/automations/store';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { buildToolProcess } from '../../helpers/bridge-tool-process';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));
import { startChannel } from '../../../src/bot/channel';

const NOW = Date.parse('2026-10-19T00:00:00Z'); // 08:00 Shanghai
const FIRES = [1792371600000, 1792458000000, 1792544400000];
const END = 1792598400000; // October 22 00:00 Shanghai, exclusive
const schedule = { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: END };
const reminder = { taskType: 'reminder', name: 'Synthetic reminder', taskText: 'Synthetic reminder body', schedule };
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });

type Call = (operation: string, params?: object) => Promise<any>;
async function harness() {
  const tmp = await createTmpProfile('reminder-tools-'); cleanups.push(tmp.cleanup);
  let now = NOW;
  const cfg = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false }, accounts: { app: { id: 'cli_bot', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_synthetic', 'ou_mate'], allowedChats: ['oc_synthetic', 'oc_other'] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' } });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' }; cfg.workspaces.default = tmp.workspace;
  const store = new AutomationsStore({ path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => now }); await store.load();
  const journal = new TurnJournal(join(tmp.profile, 'journal.json'), { now: () => now }); await journal.load();
  const channel = createRecordingLarkChannel({ chats: [{ id: 'oc_synthetic', name: 'Synthetic' }], chatMode: 'group' }); sdk.channel = channel;
  let script: (call: Call, opts: AgentRunOptions) => Promise<void> = async () => {};
  let failure: unknown; let runCount = 0;
  const agent: AgentAdapter = { id: 'codex', displayName: 'Controlled runtime', isAvailable: async () => true, run(opts) {
    return { runId: opts.runId, stop: async () => {}, waitForExit: async () => true, events: (async function* (): AsyncIterable<AgentEvent> {
      try { await script(async (operation, params = {}) => {
        const result = await client.call({ version: 1, operation, params }, opts.toolEnv);
        expect(result.code).toBe(0); expect(result.stderr).toBe(''); return JSON.parse(result.stdout);
      }, opts); } catch (error) { failure = error; }
      yield { type: 'final_text', content: `Synthetic turn ${++runCount} completed` }; yield { type: 'done', terminationReason: 'normal' };
    })() };
  } };
  const bridge = await startChannel({ cfg, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), automations: store, journal, now: () => now, probe: async () => true,
    appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
    controls: { profile: 'synthetic', profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-reminders' } });
  cleanups.push(() => bridge.disconnect());
  let message = 0;
  return { tmp, store, journal, channel, bridge, setNow: (value: number) => { now = value; },
    async turn(next: typeof script, chatId = 'oc_synthetic') {
      script = next; const count = runCount; failure = undefined;
      await channel.handlers.message?.({ messageId: `om_synthetic_${++message}`, content: '今天、明天、后天每天 09:00 提醒', chatId, chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
      await vi.waitFor(() => expect(runCount).toBeGreaterThan(count), { timeout: 12000 }); if (failure) throw failure;
    },
  };
}
function button(card: unknown, cmd: string): Record<string, string> {
  if (card && typeof card === 'object') {
    const object = card as Record<string, any>;
    if (object.value?.cmd === cmd) return object.value;
    for (const value of Object.values(object)) { try { return button(value, cmd); } catch {} }
  }
  throw new Error(`button ${cmd} not found`);
}
function click(messageId: string, value: object, extra = {}) {
  return { messageId, chatId: 'oc_synthetic', operator: { openId: 'ou_mate' }, action: { tag: 'button', value, ...extra } } as unknown as CardActionEvent;
}

it('corrects invalid input in one real client turn, confirms as a human and fires exactly three Shanghai mornings', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, schedule: { ...schedule, times: [{ hour: 99, minute: 0 }] } })).toMatchObject({ category: 'validation-failed', code: 'invalid-schedule' });
    expect(h.store.listDrafts()).toHaveLength(0);
    expect(await call('automation.preview', { taskType: 'reminder', schedule })).toMatchObject({ category: 'ok', data: { totalCount: 3, nextFires: FIRES, endAt: END } });
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'waiting-confirmation', code: 'waiting-confirmation', data: { state: 'waiting-confirmation', applied: false } });
    operationId = result.data.operationId;
    expect(operationId).toEqual(expect.any(String));
    expect(await call('automation.operation.get', { operationId })).toMatchObject(result);
    expect(await call('automation.create', { ...reminder, operationId, confirm: true })).toMatchObject({ category: 'validation-failed' });
  });
  expect(h.store.list()).toHaveLength(0); expect(h.store.listDrafts()).toHaveLength(1);
  const draft = h.store.listDrafts()[0]!;
  expect(draft).toMatchObject({ schedule, endAt: END, nextFireAt: FIRES[0], createdBy: 'ou_synthetic' });
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  for (const text of ['2026-10-19 09:00', '2026-10-20 09:00', '2026-10-21 09:00', '2026-10-22 00:00', '共 3 次']) expect(JSON.stringify(card)).toContain(text);
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true, executedCount: 0 } }); });
  for (const fireAt of FIRES) { h.setNow(fireAt); await h.bridge.wakeAutomation(`1@${fireAt}`); }
  h.setNow(END); await h.bridge.wakeAutomation(`1@${END}`);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toHaveLength(3);
  expect(h.journal.list().filter(item => item.turnId.startsWith('af:')).map(item => item.turnId)).toEqual(['af:1@1792371600000', 'af:1@1792458000000', 'af:1@1792544400000']);
  h.setNow(NOW);
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true, executedCount: 3, lastExecution: 'ok' } }); });
}, 30000);
