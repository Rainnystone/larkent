import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
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

const fsFault = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsFault.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

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
afterEach(async () => { fsFault.beforeRename = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });

type Call = (operation: string, params?: object) => Promise<any>;
async function harness(chatMode: 'group' | 'topic' = 'group') {
  const tmp = await createTmpProfile('reminder-tools-'); cleanups.push(tmp.cleanup);
  let now = NOW;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now); cleanups.push(async () => { clock.mockRestore(); });
  const cfg = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false }, accounts: { app: { id: 'cli_bot', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_synthetic', 'ou_mate'], allowedChats: ['oc_synthetic', 'oc_other'] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' } });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' }; cfg.workspaces.default = tmp.workspace;
  const makeStore = () => new AutomationsStore({ path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => now });
  let store = makeStore(); await store.load();
  const journal = new TurnJournal(join(tmp.profile, 'journal.json'), { now: () => now }); await journal.load();
  const makeChannel = (messages: unknown[] = []) => createRecordingLarkChannel({ chats: [{ id: 'oc_synthetic', name: 'Synthetic' }], chatMode, messagesByChat: messages.length ? { oc_synthetic: messages } : {} });
  let channel = makeChannel(); sdk.channel = channel;
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
  let profile = 'synthetic';
  const start = () => startChannel({ cfg, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), automations: store, journal, now: () => now, probe: async () => true,
    appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
    controls: { profile, profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-reminders' } });
  let bridge = await start();
  cleanups.push(() => bridge.disconnect());
  let message = 0;
  return { tmp, get store() { return store; }, journal, get channel() { return channel; }, get bridge() { return bridge; },
    async restart(options: { profile?: string; messages?: unknown[] } = {}) {
      const listed = await channel.rawClient.im.v1.message.list({ params: { container_id_type: 'chat', container_id: 'oc_synthetic', page_size: 100 } }) as { data: { items: unknown[] } };
      let stopError: unknown;
      try { await bridge.disconnect(); } catch (error) { stopError = error; }
      if (options.profile) profile = options.profile;
      store = makeStore(); await store.load(); await journal.load();
      channel = makeChannel(options.messages ?? listed.data.items); sdk.channel = channel;
      bridge = await start(); return stopError;
    },
    async command(content: string) {
      await channel.handlers.message?.({ messageId: `om_command_${++message}`, content, chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
    },
    setNow: (value: number) => { now = value; },
    async turn(next: typeof script, chatId = 'oc_synthetic', waitReply = true) {
      script = next; const count = runCount; failure = undefined;
      await channel.handlers.message?.({ messageId: `om_synthetic_${++message}`, content: '今天、明天、后天每天 09:00 提醒', chatId, chatType: 'group', ...(chatMode === 'topic' ? { threadId: 'omt_synthetic' } : {}), senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
      await vi.waitFor(() => expect(runCount).toBeGreaterThan(count), { timeout: 25000 });
      if (waitReply) await vi.waitFor(() => expect(channel.sent.some(item => JSON.stringify(item.content).includes(`Synthetic turn ${runCount} completed`))).toBe(true), { timeout: 12000 });
      if (failure) throw failure;
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
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true, executedCount: 3, lastExecution: 'ok' } }); });
}, 30000);

it('completes a missing end through the existing scripted card before human confirmation', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => {
    const schema = await call('automation.schema');
    const daily = schema.data.operations['automation.create'].params.properties.schedule.oneOf.find((item: any) => item.properties.kind.const === 'daily');
    expect(daily.required).not.toContain('endAt');
    const { endAt: _, ...withoutEnd } = schedule;
    const result = await call('automation.create', { ...reminder, schedule: withoutEnd });
    expect(result).toMatchObject({ category: 'needs-input', code: 'missing-end-at', data: { applied: false, fields: ['schedule.endAt'], cardMessageId: expect.any(String) } });
    operationId = result.data.operationId;
  });
  let draft = h.store.listDrafts()[0]!;
  const endCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.end.custom'))!.content;
  const action = click(draft.cardMessageId!, { ...button(endCard, 'auto.end.custom'), end_at: '2026-10-21' });
  expect(await h.channel.handlers.cardAction?.(action)).toMatchObject({ toast: { type: 'success' } });
  draft = h.store.listDrafts()[0]!;
  expect(draft).toMatchObject({ schedule, endAt: END, nextFireAt: FIRES[0] });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  const confirmCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(confirmCard, 'auto.confirm')));
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.store.list()[0]).toMatchObject({ schedule, endAt: END });
}, 30000);

it('deduplicates overlapping semantic retries across restarts and rejects conflicts, other scopes and expired IDs', async () => {
  const h = await harness(); let operationId = ''; let waiting: any;
  await h.turn(async (call, opts) => {
    operationId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW}.${'1'.repeat(32)}`;
    const results = await Promise.all([
      call('automation.create', { ...reminder, operationId }),
      call('automation.create', { taskText: reminder.taskText, name: reminder.name, taskType: 'reminder', schedule: { endAt: END, startAt: NOW, times: [{ minute: 0, hour: 9 }], timezone: 'Asia/Shanghai', kind: 'daily' }, operationId }),
    ]);
    waiting = results[0]; expect(waiting.category).toBe('waiting-confirmation'); expect(results[1]).toEqual(waiting);
    expect(await call('automation.create', { ...reminder, operationId, taskText: 'Different meaning' })).toMatchObject({ category: 'validation-failed', code: 'operation-conflict' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toEqual(waiting);
    expect(await call('automation.create', { ...reminder, operationId })).toEqual(waiting);
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
  }, 'oc_other');
  await h.restart({ profile: 'other-profile' });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' }); });
  h.setNow(NOW + 86400_001); await h.restart({ profile: 'synthetic' });
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'validation-failed', code: 'operation-expired' });
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', data: { state: 'not-applied', applied: false } });
    const neverSeen = operationId.slice(0, -32) + '2'.repeat(32);
    expect(await call('automation.create', { ...reminder, operationId: neverSeen })).toMatchObject({ category: 'validation-failed', code: 'operation-expired' });
  });
  expect(h.store.list()).toHaveLength(0);
}, 45000);

it('keeps an unprovable send unknown through restart and refuses recreation under a new ID', async () => {
  const h = await harness(); let operationId = '';
  const send = h.channel.send.bind(h.channel); let fail = true;
  h.channel.send = async (chatId, content, options) => {
    if (fail && (content as { cardId?: string }).cardId) { fail = false; throw new Error('synthetic connection outcome unknown'); }
    return send(chatId, content, options);
  };
  await h.turn(async call => {
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'unknown', code: 'card-delivery-unknown', data: { applied: null } });
    operationId = result.data.operationId;
  });
  await h.restart({ messages: [] });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { operationId, applied: null } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'unknown', data: { operationId } });
    // A fresh client-generated ID must not turn uncertainty into a second operation.
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown', code: 'prior-operation-unknown', data: { operationId } });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  expect(h.channel.rawClient.requests.some(item => item.method === 'im.v1.message.list')).toBe(true);
  h.setNow(NOW + 2 * 86400000); await h.restart({ messages: [] });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { operationId } });
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown', code: 'prior-operation-unknown', data: { operationId } });
  });
}, 30000);

it('recovers a sent card after the receipt write fails without sending a second card', async () => {
  const h = await harness(); let operationId = ''; const path = h.store.getFilePath(); const backup = `${path}.saved`;
  const send = h.channel.send.bind(h.channel); let armed = true;
  h.channel.send = async (chatId, content, options) => {
    const receipt = await send(chatId, content, options);
    if (armed && (content as { cardId?: string }).cardId) {
      armed = false; await rename(path, backup); await mkdir(path);
    }
    return receipt;
  };
  await h.turn(async call => {
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'unknown', data: { state: 'unknown', applied: null } }); operationId = result.data.operationId;
  });
  const originalCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await rm(path, { recursive: true }); await rename(backup, path);
  expect(await h.restart()).toBeDefined(); // The poisoned store still reports its real persistence failure on shutdown.
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  const draft = h.store.listDrafts()[0]!; expect(draft.cardMessageId).toEqual(expect.any(String));
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(originalCard, 'auto.confirm')));
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true } }); });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
}, 30000);

it('does not send on an initial persistence failure and proves not-applied after reloading the store', async () => {
  const h = await harness(); let operationId = ''; const path = h.store.getFilePath(); await mkdir(path);
  await h.turn(async call => {
    const result = await call('automation.create', reminder); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'unknown', data: { applied: null, operationId: expect.any(String) } });
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await rm(path, { recursive: true }); expect(await h.restart()).toBeDefined();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'operation-not-found', data: { state: 'not-applied', applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it('revokes a cancelled run credential while allowing its accepted operation to finish and be queried by a later run', async () => {
  const h = await harness(); let env: NodeJS.ProcessEnv = {}; let operationId = '';
  let entered!: () => void; const sending = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  const send = h.channel.send.bind(h.channel);
  h.channel.send = async (chatId, content, options) => {
    if ((content as { cardId?: string }).cardId) { entered(); await gate; }
    return send(chatId, content, options);
  };
  const turn = h.turn(async (call, opts) => {
    env = opts.toolEnv!;
    const result = await call('automation.create', reminder); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'unknown', data: { applied: null } });
  }, 'oc_synthetic', false);
  await sending;
  await h.command('/stop'); await turn;
  const denied = await client.call({ version: 1, operation: 'automation.list' }, env);
  expect(JSON.parse(denied.stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  release();
  await vi.waitFor(() => expect(h.store.listDrafts()[0]?.cardMessageId).toEqual(expect.any(String)), { timeout: 12000 });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } }); });
  expect(h.store.listDrafts()).toHaveLength(1); expect(h.store.list()).toHaveLength(0);
}, 30000);

it.each(['corrupted', 'timed-out'] as const)('keeps the pre-write operation ID after a %s response and recovers the sent card by querying it', async mode => {
  const h = await harness(); let operationId = '';
  await h.turn(async (call, opts) => {
    let submittedId = '';
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8'); submittedId = JSON.parse(body).params.operationId;
      const actual = await fetch(opts.toolEnv!.LARK_BRIDGE_TOOL_ENDPOINT!, { method: 'POST', body, headers: { authorization: request.headers.authorization! } });
      await actual.text(); if (mode === 'corrupted') response.end('{"version":99}');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = JSON.parse((await client.call({ version: 1, operation: 'automation.create', params: reminder }, { ...opts.toolEnv, LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tool` })).stdout);
      expect(result).toMatchObject({ category: 'unknown', data: { operationId: submittedId, applied: null } }); operationId = submittedId;
    } finally { await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }); }
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it.each(['create', 'send'] as const)('preserves a known %s rejection across restart and lets a new operation retry after that definite failure', async boundary => {
  const h = await harness(); let operationId = ''; let failed: any;
  const rejected = Object.assign(new Error('synthetic API rejection'), { response: { status: 400, data: { code: 200001, msg: 'synthetic rejection' } } });
  if (boundary === 'create') h.channel.cardErrors.create = rejected;
  else h.channel.sendErrors.send = rejected;
  await h.turn(async call => {
    failed = await call('automation.create', reminder); operationId = failed.data.operationId;
    expect(failed).toMatchObject({ category: 'execution-failed', code: 'card-send-failed', data: { applied: false, state: 'not-applied' } });
    expect(await call('automation.create', { ...reminder, operationId })).toEqual(failed);
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toEqual(failed);
    const retried = await call('automation.create', reminder);
    expect(retried).toMatchObject({ category: 'waiting-confirmation' }); expect(retried.data.operationId).not.toBe(operationId);
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it('upgrades an existing v1 manual draft and completes its original confirmation card', async () => {
  const h = await harness(); await h.command('/auto new in 15m | Synthetic legacy | Synthetic legacy body');
  const original = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  const document = JSON.parse(await readFile(h.store.getFilePath(), 'utf8'));
  document.schemaVersion = 1; delete document.operations;
  await writeFile(h.store.getFilePath(), JSON.stringify(document));
  await h.restart();
  const upgraded = await readFile(h.store.getFilePath(), 'utf8');
  expect(JSON.parse(upgraded).schemaVersion).toBe(2);
  await h.restart();
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(upgraded);
  await h.channel.handlers.cardAction?.(click(original.cardMessageId!, button(card, 'auto.confirm')));
  await h.turn(async call => { expect(await call('automation.list')).toMatchObject({ category: 'ok', data: { tasks: [{ id: 1, taskType: 'reminder', name: 'Synthetic legacy', nextFireAt: NOW + 900000 }] } }); });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
}, 30000);

it('reports offline creation as received without a sent card, then sends it once after restart', async () => {
  const h = await harness(); let operationId = '';
  h.channel.sendErrors.send = Object.assign(new Error('synthetic network failure'), { code: 'ENETDOWN' });
  await h.turn(async call => {
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown' });
    const result = await call('automation.create', { ...reminder, name: 'Synthetic offline reminder' });
    expect(result).toMatchObject({ category: 'execution-failed', code: 'card-not-sent', data: { applied: false } }); operationId = result.data.operationId;
  }, 'oc_synthetic', false);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  expect(h.store.list()).toHaveLength(0);
}, 30000);

it('rejects future-dated IDs so a caller cannot bypass the submission lifetime', async () => {
  const h = await harness();
  await h.turn(async (call, opts) => {
    const operationId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW + 86400000}.${'f'.repeat(32)}`;
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'validation-failed', code: 'invalid-operation-id' });
  });
  expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('never reports an applied operation before the confirmation write commits', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => { const result = await call('automation.create', reminder); operationId = result.data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  let armed = true;
  fsFault.beforeRename = async destination => {
    if (armed && destination === h.store.getFilePath()) { armed = false; entered(); await gate; }
  };
  const confirming = Promise.resolve(h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm'))));
  void confirming.catch(() => {});
  await writing;
  try {
    await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).not.toMatchObject({ category: 'applied' }); });
  } finally { release(); }
  await confirming;
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true } }); });
}, 30000);

it('recovers every submitted semantic-retry ID after its response is lost and the original task is confirmed', async () => {
  const h = await harness(); let originalId = ''; let retriedId = '';
  await h.turn(async (call, opts) => {
    const first = await call('automation.create', reminder); originalId = first.data.operationId;
    retriedId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW}.${'a'.repeat(32)}`;
    // The model loses this response and retains only the ID known before submission.
    await call('automation.create', { ...reminder, operationId: retriedId });
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId: retriedId })).toMatchObject({ category: 'applied', data: { operationId: originalId, taskId: 1, applied: true } });
    expect(await call('automation.create', { ...reminder, operationId: retriedId })).toMatchObject({ category: 'applied', data: { taskId: 1 } });
  });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it.each(['delivery', 'operations', 'delivery-state', 'operation-state'] as const)('refuses malformed v2 %s data without losing the original uncertain receipt', async field => {
  const h = await harness();
  h.channel.sendErrors.send = new Error('synthetic uncertain send');
  await h.turn(async call => { expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown' }); });
  const document = JSON.parse(await readFile(h.store.getFilePath(), 'utf8'));
  if (field === 'delivery') document.drafts[0].delivery = {};
  else if (field === 'delivery-state') document.drafts[0].delivery.state = ['sending'];
  else if (field === 'operation-state') document.operations[0].state = ['received'];
  else delete document.operations;
  const corrupted = JSON.stringify(document); await writeFile(h.store.getFilePath(), corrupted);
  await expect(h.restart()).rejects.toThrow(/Invalid automation/);
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(corrupted);
}, 30000);

it('keeps a topic-group confirmation card in the originating topic', async () => {
  const h = await harness('topic');
  await h.turn(async call => { expect(await call('automation.create', reminder)).toMatchObject({ category: 'waiting-confirmation' }); });
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!;
  expect(card.options).toMatchObject({ replyTo: 'om_synthetic_1', replyInThread: true });
}, 30000);

it('serializes end completion with a concurrent recovery query so one confirmation card is created', async () => {
  const h = await harness(); let operationId = '';
  const createdCards: unknown[] = []; const createCard = h.channel.createCard.bind(h.channel);
  h.channel.createCard = async card => { const result = await createCard(card); createdCards.push(card); return result; };
  await h.turn(async call => {
    const { endAt: _, ...withoutEnd } = schedule;
    operationId = (await call('automation.create', { ...reminder, schedule: withoutEnd })).data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.end.custom'))!.content;
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); }); let armed = true;
  fsFault.beforeRename = async destination => {
    if (armed && destination === h.store.getFilePath()) { armed = false; entered(); await gate; }
  };
  const completing = Promise.resolve(h.channel.handlers.cardAction?.(click(draft.cardMessageId!, { ...button(card, 'auto.end.custom'), end_at: '2026-10-21' })));
  void completing.catch(() => {}); await writing;
  const querying = h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  try { await vi.waitFor(() => expect(h.store.listDrafts()[0]?.delivery?.state).toBe('prepared'), { timeout: 12000 }); } finally { release(); }
  await completing; await querying;
  expect(createdCards).toHaveLength(2); // one end card and one confirmation card
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it('records human rejection as not-applied and keeps the same operation closed after restart', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => { operationId = (await call('automation.create', reminder)).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.reject')))).toMatchObject({ toast: { type: 'success' } });
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'draft-closed', data: { state: 'not-applied', applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'execution-failed', code: 'draft-closed' });
  });
  expect(h.store.list()).toHaveLength(0); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('pauses an existing task immediately through the real client and queries its durable receipt after restart', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toContainEqual(expect.objectContaining({ id: item.id, paused: false }));
    const result = await call('automation.pause', { id: item.id });
    expect(result).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
    operationId = result.data.operationId;
    expect((await call('automation.list')).data.tasks).toContainEqual(expect.objectContaining({ id: item.id, paused: true }));
  });
  expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
  });
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toBe(false);
}, 30000);
