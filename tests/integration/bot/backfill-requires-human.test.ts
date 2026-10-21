import { join } from 'node:path';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import { AutomationsStore } from '../../../src/automations/store';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const NOW = Date.parse('2026-10-19T00:00:00Z');
const BOT = 'ou_bot';
const USER = 'ou_synthetic';
const OTHER_APP = 'cli_other';
const CHAT = 'oc_synthetic';
const TEXT = '列出本群自动化';

let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => {
  client = await buildToolProcess();
}, 30_000);
afterAll(async () => {
  await client?.cleanup();
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  sdk.channel = undefined;
});

it('lists automations after a stopped bridge backfills a human mention', async () => {
  const listed = await backfillList('user', USER);
  expect(listed).toMatchObject({ category: 'ok', data: { tasks: [] } });
  expect(listed).not.toMatchObject({ code: 'automation-requires-human' });
});

it('keeps automation-requires-human after backfilling an app mention', async () => {
  expect(await backfillList('app', OTHER_APP)).toMatchObject({
    category: 'unavailable',
    code: 'automation-requires-human',
  });
});

async function backfillList(senderType: 'user' | 'app', senderId: string): Promise<unknown> {
  const tmp = await createTmpProfile('backfill-human-');
  cleanups.push(tmp.cleanup);
  const ledger = new BackfillLedger(join(tmp.profile, 'backfill-state.json'), { now: () => NOW });
  await ledger.load();
  ledger.touchLive(NOW - 5 * 60_000);
  const cfg = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_bot', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: [USER, OTHER_APP], allowedChats: [CHAT], admins: [USER] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', cotMessages: 'off' },
    codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' };
  cfg.workspaces.default = tmp.workspace;
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'status.json'),
    now: () => NOW,
  });
  await store.load();
  let listed: unknown;
  let agentError: unknown;
  const agent: AgentAdapter = {
    id: 'codex',
    displayName: 'Backfill human seam',
    isAvailable: async () => true,
    run(opts) {
      return {
        runId: opts.runId,
        stop: async () => {},
        waitForExit: async () => true,
        events: (async function* (): AsyncIterable<AgentEvent> {
          try {
            const env = opts.toolEnv;
            expect(env?.LARK_BRIDGE_TOOL_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:/);
            const child = await client.call({ version: 1, operation: 'automation.list' }, env);
            expect(child.code).toBe(0);
            expect(child.stderr).toBe('');
            listed = JSON.parse(child.stdout);
          } catch (error) {
            agentError = error;
            listed = { failed: true };
          }
          yield { type: 'final_text', content: 'listed' };
          yield { type: 'done', terminationReason: 'normal' };
        })(),
      };
    },
  };
  const channel = createRecordingLarkChannel({
    botIdentity: { openId: BOT, name: 'Bot' },
    chats: [{ id: CHAT, name: 'Group' }],
    messagesByChat: { [CHAT]: [historyMention(senderType, senderId)] },
    chatMode: 'group',
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    ledger,
    automations: store,
    now: () => NOW,
    probe: async () => true,
    appPaths: {
      mediaDir: join(tmp.profile, 'media'),
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, 'salt'),
    },
    controls: {
      profile: 'synthetic',
      profileConfig: cfg,
      cfg,
      botOwnerId: USER,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'backfill-human',
    },
  });
  cleanups.push(() => bridge.disconnect());
  await vi.waitFor(() => expect(listed).toBeDefined(), { timeout: 12_000 });
  if (agentError) throw agentError;
  return listed;
}

function historyMention(senderType: 'user' | 'app', senderId: string): Record<string, unknown> {
  return {
    message_id: `om_${senderType}`,
    chat_id: CHAT,
    msg_type: 'text',
    create_time: String(NOW - 90_000),
    deleted: false,
    sender: { id: senderId, id_type: 'open_id', sender_type: senderType },
    body: { content: JSON.stringify({ text: `@_user_1 ${TEXT}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
  };
}
