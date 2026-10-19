import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import { AutomationsStore } from '../../../src/automations/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { buildToolProcess } from '../../helpers/bridge-tool-process';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const NOW = Date.parse('2026-10-19T00:00:00Z'); // 08:00 Shanghai
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); sdk.channel = undefined; });

it('discovers and reads automation, corrects real preview feedback in the same IM turn without writing', async () => {
  const tmp = await createTmpProfile('tools-im-');
  cleanup.push(tmp.cleanup);
  const cfg = createDefaultProfileConfig({
    agentKind: 'codex', codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false }, accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_synthetic'], allowedChats: ['oc_synthetic'] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' };
  cfg.workspaces.default = tmp.workspace;
  const store = new AutomationsStore({ path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => NOW });
  await store.load();
  const responses: any[] = [];
  const processClient = await buildToolProcess();
  cleanup.push(processClient.cleanup);
  let agentError: unknown;
  let captured: AgentRunOptions | undefined;
  const runs: AgentRunOptions[] = [];
  let holdRun = false;
  let markHeldRunReady!: (opts: AgentRunOptions) => void;
  let rejectHeldRunReady!: (error: unknown) => void;
  const heldRunReady = new Promise<AgentRunOptions>((resolve, reject) => {
    markHeldRunReady = resolve;
    rejectHeldRunReady = reject;
  });
  void heldRunReady.catch(() => {});
  const agent: AgentAdapter = {
    id: 'codex', displayName: 'Controllable Codex seam', isAvailable: async () => true,
    run(opts) {
      captured = opts;
      runs.push(opts);
      let release = () => {};
      const stopped = new Promise<void>(resolve => { release = resolve; });
      return {
        runId: opts.runId, stop: async () => { release(); }, waitForExit: async () => true,
        events: (async function* (): AsyncIterable<AgentEvent> {
          try {
            yield { type: 'system', resumeHandle: 'synthetic-thread' };
            const env = (opts as AgentRunOptions & { toolEnv?: NodeJS.ProcessEnv }).toolEnv;
            expect(env?.LARK_BRIDGE_TOOL_ENDPOINT, 'this IM run must supply the real client connection').toMatch(/^http:\/\/127\.0\.0\.1:/);
            const call = async (operation: string, params = {}) => {
              const child = await processClient.call({ version: 1, operation, params }, env!);
              expect(child.code).toBe(0); expect(child.stderr).toBe('');
              const result = JSON.parse(child.stdout);
              responses.push(result);
              return result;
            };
            expect((await call('plugins.list')).data.plugins[0].id).toBe('automation');
            if (holdRun) { markHeldRunReady(opts); await stopped; yield { type: 'done', terminationReason: 'interrupted' }; return; }
            const inspected = await call('plugins.inspect', { plugin: 'automation' });
            expect(inspected.data.skills[0].id).toBe('automation:automations');
            expect((await call('plugins.read', { skill: 'automation:automations' })).data.content).toContain('automation.preview');
            expect((await call('automation.schema')).data.operations['automation.create'].available).toBe(false);
            expect((await call('automation.list')).data.tasks).toEqual([]);
            const schedule = { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW };
            const invalid = await call('automation.preview', { taskType: 'reminder', schedule });
            expect(invalid).toMatchObject({ category: 'needs-input', code: 'missing-end-at', data: { fields: ['schedule.endAt'] } });
            if (invalid.code !== 'missing-end-at') throw new Error('expected actionable bridge feedback');
            const preview = await call('automation.preview', { taskType: 'reminder', schedule: { ...schedule, endAt: Date.parse('2026-10-21T16:00:00Z') } });
            expect(preview).toMatchObject({ category: 'ok', data: { timezone: 'Asia/Shanghai', totalCount: 3, endExclusive: true,
              nextFires: [1792371600000, 1792458000000, 1792544400000], endAt: 1792598400000 } });
            // A resumed transcript may still emit the old protocol. A tool-using run must not apply it too.
            yield { type: 'final_text', content: `预览共 ${preview.data.totalCount} 次，每天 09:00；结束于 22 日 00:00，尚未创建。\n<automation_proposal>{"taskType":"reminder","schedule":"10 分钟后","name":"synthetic legacy","taskText":"synthetic legacy"}</automation_proposal>` };
          } catch (err) { agentError = err; if (holdRun) rejectHeldRunReady(err); yield { type: 'final_text', content: 'client path failed' }; }
          yield { type: 'done', terminationReason: 'normal' };
        })(),
      };
    },
  };
  const channel = createRecordingLarkChannel({ chats: [{ id: 'oc_synthetic', name: 'Synthetic' }], chatMode: 'group', botIdentity: { openId: 'ou_synthetic_bot', name: 'Synthetic' } });
  sdk.channel = channel;
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json')); await catalog.load();
  const bridge = await startChannel({ cfg, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')), sessionCatalog: catalog, workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), automations: store,
    now: () => NOW, probe: async () => true,
    appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
    controls: { profile: 'synthetic', profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-tools' },
  });
  cleanup.push(() => bridge.disconnect());
  await channel.handlers.message?.({ messageId: 'om_synthetic', content: '今天、明天、后天每天 09:00，先预览', chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: NOW, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
  await vi.waitFor(() => expect(channel.sent.some(s => JSON.stringify(s.content).includes('尚未创建')) || agentError).toBeTruthy(), { timeout: 12000 });
  if (agentError) throw agentError;
  expect(captured?.prompt).toContain('automation');
  expect(captured?.prompt).not.toContain('automation_proposal');
  expect(captured?.prompt).not.toContain('automation.preview'); // only revealed on demand
  expect(responses).toHaveLength(7);
  expect(store.list()).toEqual([]);
  expect(store.listDrafts()).toEqual([]);
  expect(channel.sent.some(s => JSON.stringify(s.content).includes('auto.confirm'))).toBe(false);
  expect(channel.sent.some(s => JSON.stringify(s.content).includes('automation_proposal'))).toBe(false);
  const firstEnv = captured!.toolEnv!;
  expect(JSON.parse((await processClient.call({ version: 1, operation: 'automation.list' }, firstEnv)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });

  const send = (messageId: string, content: string) => channel.handlers.message?.({ messageId, content, chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: NOW, raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
  await send('om_resumed', '再预览');
  await vi.waitFor(() => expect(channel.sent.filter(s => JSON.stringify(s.content).includes('尚未创建'))).toHaveLength(2), { timeout: 12000 });
  if (agentError) throw agentError;
  expect(runs[0]?.resumeHandle).toBeUndefined();
  expect(runs[1]?.resumeHandle).toBe('synthetic-thread');
  expect(runs[1]?.toolEnv?.LARK_BRIDGE_TOOL_TOKEN).not.toBe(firstEnv.LARK_BRIDGE_TOOL_TOKEN);
  expect(runs[1]?.prompt).toContain('bridge_plugins');

  holdRun = true;
  await send('om_stop_run', '预览并等待');
  const stopEnv = (await heldRunReady).toolEnv!;
  await send('om_stop', '/stop');
  expect(JSON.parse((await processClient.call({ version: 1, operation: 'automation.list' }, stopEnv)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  expect(store.list()).toEqual([]); expect(store.listDrafts()).toEqual([]);
  // Allow both 12-second full turns, a 10-second held client call, setup and stop.
}, 45000);
