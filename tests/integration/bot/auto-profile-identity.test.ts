import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationsStore } from '../../../src/automations/store';
import { formatFireKey } from '../../../src/automations/schedule';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { installProfileIdentityCli, type IdentityPlan } from '../../helpers/profile-identity-cli';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { waitForFile } from '../../helpers/wait-for-file';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const NOW = Date.UTC(2026, 9, 19);
const HOUR = 3600000;
const CHAT = 'oc_synthetic_identity';
const CREATOR = 'ou_synthetic_creator';
const SUBJECT = 'ou_synthetic_profile_subject';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  sdk.channel = undefined;
  vi.unstubAllEnvs();
});

describe('profile identity in existing automatic tasks', { timeout: 20000 }, () => {
it.each([
  { args: ['auth', 'logout', '--help'], usage: 'Usage: lark-cli auth logout [options]' },
  { args: ['auth', 'login', '-h'], usage: 'Usage: lark-cli auth login [options]' },
  { args: ['profile', 'add', '--help'], usage: 'Usage: lark-cli profile add [options]' },
  { args: ['config', 'set', '--help'], usage: 'Usage: lark-cli config set [options]' },
  { args: ['help', 'auth', 'logout'], usage: 'Usage: lark-cli auth logout [options]' },
])('completes read-only help without pausing the automatic task: $args', async ({ args, usage }) => {
  const h = await harness({ args });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ lastStatus: 'ok', paused: false });
  expect(h.bodies()).toContain(usage);
  expect(await h.calls()).toEqual([expect.objectContaining({ args, env: h.env })]);
  expect(await h.store.readLog()).toEqual([]);
  await h.configUnchanged();
});

it.each([
  ['auth', 'logout'],
  ['config', 'set', 'k', 'v'],
  ['auth', 'logout', '--', '--help'],
])('exposes the audited auth-config code in the interruption result and Chinese notice: %j', async (...args) => {
  const h = await harness({ args, hold: true });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ lastStatus: 'failed', paused: true });
  expect(h.journal.get(`af:1@${NOW + HOUR}`)?.outcome).toMatchObject({
    kind: 'interrupted', reason: { type: 'policy-guard', code: 'auth-config' },
  });
  expect(h.bodies()).toContain('策略拦截（认证/身份配置变更，auth-config）');
  expect(await h.store.readLog()).toEqual([
    expect.objectContaining({ result: 'policy-guard', reason: 'auth-config' }),
  ]);
  expect(await h.calls()).toEqual([]);
  await h.configUnchanged();
  await h.cli.plan('query', {
    args: ['auth', 'status'], bridgeRequests: [{ operation: 'automation.list' }],
  });
  await h.message('query');
  await vi.waitFor(() => expect(h.bodies()).toContain(
    '"lastInterruption":{"code":"auth-config","message":"认证/身份配置变更"}',
  ), { timeout: 10000 });
  await h.configUnchanged();
});

it('waits for real automatic settlement when a healthy subprocess outlasts the old polling budget', async () => {
  const h = await harness({ args: ['docs', '+fetch', '--as', 'user'], hold: true });
  await h.fire();
  await h.waitForFile(join(h.cli.directory, 'automatic.ready'));
  const outcome = h.settled().then(() => undefined, error => error);
  // Exercise the former ten-second fixture deadline while the real child is
  // deliberately held, then release it and observe its successful completion.
  await once(AbortSignal.timeout(10_000), 'abort');
  expect(h.store.get(1)?.lastStatus).toBe('running');
  await writeFile(join(h.cli.directory, 'automatic.release'), 'release');
  await h.waitForFile(h.store.getFilePath(), content => JSON.parse(content).items[0]?.lastStatus === 'ok');
  expect(await outcome).toBeUndefined();
  expect(h.store.get(1)).toMatchObject({ lastStatus: 'ok', paused: false, createdBy: CREATOR });
  expect(h.bodies()).toContain(`identity-result:{"identity":"user","subject":"${SUBJECT}","generation":1}`);
  await h.configUnchanged();
});

it('runs an existing automatic task with the profile user authorization and preserves its separate creator', async () => {
  const h = await harness({ args: ['docs', '+fetch', '--as', 'user'] });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ createdBy: CREATOR, paused: false, lastStatus: 'ok' });
  expect(h.bodies()).toContain(`identity-result:{"identity":"user","subject":"${SUBJECT}","generation":1}`);
  expect(await h.calls()).toEqual([expect.objectContaining({ args: ['docs', '+fetch', '--as', 'user'], env: h.env })]);
  expect(await h.store.readLog()).toEqual([]);
  await h.configUnchanged();
});

it.each(['bot', 'user', 'denied', 'missing-cli', 'direct-send'] as const)('creates with an actual runtime client, then reads plugins and executes with profile identity in the scheduled subprocess (%s)', async identity => {
  const args = identity === 'direct-send' ? ['im', '+messages-send', '--chat-id', CHAT, '--text', 'Synthetic direct result'] : ['docs', '+fetch', '--as', identity === 'bot' ? 'bot' : 'user'];
  const h = await harness({ args, bridgeRequests: [{ operation: 'plugins.read', params: { skill: 'automations' } }] }, { seed: false, ...(identity === 'denied' ? { failure: 'synthetic platform authorization denied' } : {}) });
  await h.cli.plan('creator', { args: ['auth', 'status'], bridgeRequests: [{ operation: 'automation.create', params: {
    taskType: 'agent', name: 'Synthetic subprocess task', taskText: 'identity-case:automatic', schedule: { kind: 'interval', timezone: 'UTC', every: { unit: 'hours', n: 1 }, startAt: NOW, endAt: NOW + 3 * HOUR },
  } }] });
  await h.message('creator');
  await vi.waitFor(() => expect(h.bodies()).toContain('bridge-results:'), { timeout: 10000 });
  expect(h.bodies()).toContain('waiting-confirmation');
  expect(h.store.list()).toEqual([]);
  const draft = h.store.listDrafts()[0]!;
  const findButton = (value: any): any => {
    if (!value || typeof value !== 'object') return;
    if (value.value?.cmd === 'auto.confirm') return value.value;
    for (const child of Object.values(value)) { const found = findButton(child); if (found) return found; }
  };
  const card = h.channel.sent.find(row => JSON.stringify(row.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.({ messageId: draft.cardMessageId, chatId: CHAT, operator: { openId: CREATOR }, action: { tag: 'button', value: findButton(card) } })).toMatchObject({ toast: { type: 'success' } });
  if (identity === 'missing-cli') await rename(h.cli.agent, `${h.cli.agent}.moved`);
  await h.fire(); await h.settled();
  if (identity === 'missing-cli') {
    expect(h.journal.get(`af:1@${NOW + HOUR}`)?.outcome?.kind).toBe('failed');
    expect(h.bodies()).toContain('运行启动失败');
    expect(h.store.list()).toMatchObject([{ id: 1, taskType: 'agent', lastStatus: 'failed' }]);
    await h.configUnchanged();
    return;
  }
  if (identity === 'direct-send') {
    expect(h.journal.get(`af:1@${NOW + HOUR}`)).toMatchObject({ cliAlreadySent: true, outcome: { kind: 'completed' } });
    await h.cli.plan('query', { args: ['auth', 'status'], bridgeRequests: [{ operation: 'automation.operation.get', params: { operationId: draft.operationId } }] });
    await h.message('query');
    await vi.waitFor(() => expect(h.bodies()).toContain('lastDelivery'), { timeout: 10000 });
    expect(h.bodies()).toContain('"deliveredCount":1');
    expect(h.bodies()).toContain('"lastDelivery":"sent"');
    await h.configUnchanged();
    return;
  }
  if (identity === 'denied') {
    expect(h.bodies()).toContain('自动化任务中断');
    expect(h.bodies()).not.toContain('identity-result:');
  } else {
    expect(h.bodies()).toContain(identity === 'bot' ? 'identity-result:{"identity":"bot"}' : `identity-result:{"identity":"user","subject":"${SUBJECT}","generation":1}`);
    expect(h.bodies()).toContain('automation.preview');
  }
  expect(h.store.list()).toMatchObject([{ createdBy: CREATOR, chatId: CHAT, taskType: 'agent', lastStatus: identity === 'denied' ? 'failed' : 'ok' }]);
  expect((await h.runs()).find(run => run.id === 'automatic')).toMatchObject({ hasToolConnection: true, resumed: false });
  expect((await h.calls()).at(-1)).toMatchObject({ env: h.env, args });
  await h.configUnchanged();
}, 30000);

it.each([
  ['auth', 'logout'], ['auth', 'login', '--no-wait'],
  ['config', 'strict-mode', 'off'], ['config', 'strict-mode', 'bot'],
  ['config', 'default-as', 'user'], ['config', 'default-as', 'bot'],
  ['config', 'set', 'default-as', 'bot'], ['config', 'set', 'strict-mode', 'off'],
  ['config', 'bind', '--identity', 'user-default'], ['config', 'remove'], ['config', 'init'],
  ['config', 'tenant-access-token', 'set'], ['config', 'tenant-access-token', 'remove'],
  ['config', 'keychain-downgrade'], ['config', 'risk-control', 'off'], ['config', 'risk-control', 'default'],
  ['profile', 'add', 'synthetic'], ['profile', 'remove', 'synthetic'], ['profile', 'rename', 'synthetic', 'synthetic-next'],
])('interrupts unattended configuration change %j, pauses and audits without running it', async (...args) => {
  const h = await harness({ args, hold: true });
  await h.fire();
  await vi.waitFor(() => expect(h.store.get(1)?.paused).toBe(true), { timeout: 10000 });
  await h.settled();
  expect(h.bodies()).toContain('策略拦截（认证/身份配置变更，auth-config）');
  expect(h.bodies()).not.toContain('在本消息话题里追问');
  expect(await h.calls()).toEqual([]);
  const audit = await h.store.readLog();
  expect(audit).toEqual([expect.objectContaining({ result: 'policy-guard', reason: 'auth-config' })]);
  expect(JSON.stringify(audit)).not.toMatch(/ou_synthetic|oc_synthetic|identity-case/);
  await h.configUnchanged();
});

it.each(['group', 'topic'] as const)('starts a human thread after a configuration guard notice without resuming the blocked fire (%s)', async chatMode => {
  const h = await harness({ args: ['auth', 'login'], hold: true }, { chatMode });
  await h.fire();
  await h.settled();
  const notice = h.journal.list().find(entry => entry.turnId.startsWith('af:'))?.reply?.messageId;
  expect(notice).toMatch(/^om_/);
  await h.cli.plan('follow', { args: ['docs', '+fetch', '--as', 'user'] });
  await h.message('follow', notice);
  await vi.waitFor(() => expect(h.bodies()).toContain('identity-result:'), { timeout: 10000 });
  const follow = (await h.runs()).find(run => run.id === 'follow');
  expect(follow).toMatchObject({ resumed: false, hasToolConnection: true });
  expect(follow?.systemPrompt).not.toContain('无人值守自动化');
  expect(h.journal.list().find(entry => entry.messageIds.includes('om_synthetic_follow'))?.scope).toBe(`${CHAT}:${notice}`);
  expect(h.store.get(1)?.paused).toBe(true);
});

it('gives an automatic subprocess an identity contract without the human OAuth/configuration workflow', async () => {
  const h = await harness({ args: ['auth', 'status', '--json'] });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ paused: false, lastStatus: 'ok' });
  const [run] = await h.runs();
  expect(run?.systemPrompt).toContain('沿用当前 profile 已授权的 bot 或 user 身份');
  expect(run?.systemPrompt).toContain('读取认证状态');
  expect(run?.systemPrompt).not.toContain('飞书 OAuth 授权（');
  expect(run?.systemPrompt).not.toContain('内部顺序执行身份策略收敛');
  expect(run?.systemPrompt).not.toContain('只用 bot 身份');
  expect(run?.systemPrompt).toContain('最终回答发到触发会话');
  expect(h.bodies()).toContain('authorized-profile-status');
  await h.configUnchanged();
});

it.each([
  ['im', '+chat-create'], ['im', 'chat.members', 'create'], ['im', 'chats', 'delete'],
  ['im', '+chat-update'], ['contact', '+search-user'], ['corehr', 'employees', 'search'],
])('runs authorized business operations without the retired category restriction: %j', async (...args) => {
  const h = await harness({ args });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ paused: false, lastStatus: 'ok' });
  expect(h.bodies()).toContain('identity-result:{"identity":"bot"}');
  expect(await h.store.readLog()).toEqual([]);
});

it('shares the profile store between concurrent human and automatic subprocesses and leaves refresh to the CLI', async () => {
  const h = await harness({ args: ['docs', '+fetch', '--as', 'user', '--wait-for-peer'] });
  await h.cli.plan('human', { args: ['docs', '+fetch', '--as=user', '--wait-for-peer'] });
  await h.message('human');
  await h.fire();
  await h.settled();
  await vi.waitFor(() => expect(h.bodies().match(/"generation":1/g)).toHaveLength(2), { timeout: 10000 });
  expect(await h.calls()).toEqual([
    expect.objectContaining({ env: h.env }), expect.objectContaining({ env: h.env }),
  ]);
  const runs = await h.runs();
  expect(runs.find(run => run.id === 'human')).toMatchObject({ hasToolConnection: true });
  expect(runs.find(run => run.id === 'automatic')).toMatchObject({ hasToolConnection: true });
  expect(runs.find(run => run.id === 'human')?.systemPrompt).toContain('飞书 OAuth 授权（');
  expect(runs.find(run => run.id === 'automatic')?.systemPrompt).not.toContain('飞书 OAuth 授权（');
  expect(JSON.parse(await readFile(join(h.configDir, 'credential-substitute.json'), 'utf8'))).toEqual({ subject: SUBJECT, generation: 1, expired: false });
  const files = await readdir(h.configDir);
  expect(files.filter(name => !name.startsWith('peer-')).sort()).toEqual(['config.json', 'credential-substitute.json']);
  expect(files.filter(name => name.startsWith('peer-'))).toHaveLength(2);
  await h.configUnchanged();
  await h.cli.plan('human-after', { args: ['docs', '+fetch', '--as', 'user'] });
  await h.message('human-after');
  await vi.waitFor(() => expect(h.bodies().match(/"generation":1/g)).toHaveLength(3), { timeout: 10000 });
  expect((await h.calls())[2]?.env).toEqual(h.env);
  await h.configUnchanged();
});

it.each([
  ['missing', { missing: true }], ['expired', { expired: true }],
  ['platform denial', { failure: 'platform permission denied (synthetic)' }],
  ['explicit bot policy', { strictMode: 'bot' }],
  ['missing CLI capability', { failure: 'dependency unavailable: CLI needs profile binding and locked refresh/writeback' }],
] as const)('records a real subprocess failure for %s without login, success or a policy pause', async (_label, options) => {
  const h = await harness({ args: ['docs', '+fetch', '--as', 'user'] }, options);
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ lastStatus: 'failed', paused: false, createdBy: CREATOR });
  expect(h.bodies()).toContain('自动化任务中断');
  expect(h.bodies()).not.toMatch(/identity-result|在本消息话题里追问|https?:|device.code/);
  expect(await h.calls()).toEqual([expect.objectContaining({ args: ['docs', '+fetch', '--as', 'user'], env: h.env })]);
  expect(await h.store.readLog()).toEqual([]);
  expect(h.journal.list().find(entry => entry.turnId.startsWith('af:'))?.outcome?.kind).toBe('failed');
  await h.configUnchanged();
});

it.each([
  ['auth', 'status', '--json', '--verify'], ['config', 'show'], ['config', 'strict-mode'], ['config', 'default-as'],
  ['config', 'risk-control'], ['profile', 'list'],
  ['im', '+chat-messages-list', '--as', 'bot'], ['docs', '+fetch', '--identity=user-default'],
])('allows status queries and existing identity selection: %j', async (...args) => {
  const h = await harness({ args });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ lastStatus: 'ok', paused: false });
  expect(await h.calls()).toEqual([expect.objectContaining({ args, env: h.env })]);
  await h.configUnchanged();
});

it.each([
  { toolName: 'lark_cli_auth_logout', toolInput: {} },
  { toolName: 'lark.config.set', toolInput: {} },
  { toolInput: { cmd: 'env SYNTHETIC=1 lark-cli config strict-mode --reset' } },
  { toolInput: { command: 'bash -c "lark-cli config default-as bot"' } },
  { toolInput: { rawInput: { command: ['lark-cli', 'auth', 'logout'] } } },
  { toolInput: { command: 'lark-cli auth status && lark-cli auth login --no-wait' } },
  { toolInput: { command: 'lark-cli config show;lark-cli config strict-mode off' } },
  { toolInput: { command: 'lark-cli config show || lark-cli config default-as bot' } },
  { toolInput: { command: 'lark-cli --profile synthetic config --as bot strict-mode off' } },
  { toolInput: { command: 'bash -c "lark-cli auth status && lark-cli auth logout"' } },
  { toolInput: { command: 'lark-cli config show\nlark-cli config strict-mode off' } },
  { toolInput: { command: 'lark-cli auth status\r\nlark-cli auth logout' } },
])('observes configuration changes in supported tool-event shapes: %j', async shape => {
  const h = await harness({ args: ['auth', 'logout'], hold: true, ...shape });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ paused: true, lastStatus: 'failed' });
  expect(await h.calls()).toEqual([]);
  await h.configUnchanged();
});

it('interrupts a later authentication mutation after a read in the same shell command', async () => {
  const h = await harness({ args: ['auth', 'logout'], hold: true, toolInput: { command: 'lark-cli auth status && lark-cli auth logout' } });
  await h.fire();
  await vi.waitFor(() => expect(h.store.get(1)?.paused).toBe(true), { timeout: 10000 });
  await h.settled();
  expect(await h.calls()).toEqual([]);
  await h.configUnchanged();
});

it('interrupts an authentication mutation after an unquoted newline in a shell command', async () => {
  const h = await harness({ args: ['auth', 'logout'], hold: true, toolInput: { command: 'lark-cli auth status\nlark-cli auth logout' } });
  await h.fire();
  await vi.waitFor(() => expect(h.store.get(1)?.paused).toBe(true), { timeout: 10000 });
  await h.settled();
  expect(await h.calls()).toEqual([]);
  await h.configUnchanged();
});

it.each([
  ['im', '+chat-create', '--name', 'config', '--description', 'set'],
  ['im', '+chat-create', '--name', 'lark-cli', '--description', 'auth', 'login'],
  ['im', '+chat-create', '--description', 'lark-cli auth logout'],
])('does not treat business option values as authentication/configuration subcommands: %j', async (...args) => {
  const h = await harness({ args });
  await h.fire();
  await h.settled();
  expect(h.store.get(1)).toMatchObject({ paused: false, lastStatus: 'ok' });
  expect(h.bodies()).toContain('identity-result:{"identity":"bot"}');
  expect(await h.store.readLog()).toEqual([]);
});

it('interrupts native profile switching before the controlled CLI can change the selected profile', async () => {
  const h = await harness({ args: ['profile', 'use', 'synthetic'], hold: true });
  await h.fire();
  await vi.waitFor(() => expect(h.store.get(1)?.paused).toBe(true), { timeout: 10000 });
  await h.settled();
  expect(await h.calls()).toEqual([]);
  await h.configUnchanged();
});

});

async function harness(plan: IdentityPlan, options: { strictMode?: string; failure?: string; expired?: boolean; missing?: boolean; chatMode?: 'group' | 'topic'; seed?: boolean } = {}) {
  const tmp = await createTmpProfile('auto-profile-identity-');
  cleanup.push(tmp.cleanup);
  const cli = await installProfileIdentityCli(tmp.root);
  vi.stubEnv('PATH', `${cli.directory}${delimiter}${process.env.PATH ?? ''}`);
  const configDir = join(tmp.profile, 'lark-cli');
  const sourceDir = join(tmp.profile, 'lark-cli-source');
  await mkdir(configDir);
  await mkdir(sourceDir);
  const config = JSON.stringify({ strictMode: options.strictMode ?? 'off', defaultAs: 'bot', ...(options.failure ? { failure: options.failure } : {}) });
  const source = '{"synthetic":"profile-source"}';
  await writeFile(join(configDir, 'config.json'), config);
  await writeFile(join(sourceDir, 'config.json'), source);
  if (!options.missing) await writeFile(join(configDir, 'credential-substitute.json'), JSON.stringify({ subject: SUBJECT, generation: 0, expired: options.expired ?? false }));
  await cli.plan('automatic', plan);
  const env = {
    LARK_CHANNEL: '1', LARK_CHANNEL_HOME: tmp.root, LARK_CHANNEL_PROFILE: 'synthetic',
    LARK_CHANNEL_CONFIG: join(sourceDir, 'config.json'), LARKSUITE_CLI_CONFIG_DIR: configDir,
  };
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude', binaryPath: cli.agent,
    accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: [CREATOR], allowedChats: [CHAT] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' },
  });
  cfg.automations = { enabled: true, agentTasks: true, timezone: 'UTC' };
  cfg.larkCli = { identityPreset: 'user-default' };
  cfg.workspaces.default = tmp.workspace;
  const profileBefore = JSON.stringify(cfg);
  let now = NOW;
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now: () => now });
  await journal.load();
  const store = new AutomationsStore({ journal, path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => now });
  await store.load();
  if (options.seed !== false) await store.create({ taskType: 'agent', schedule: { kind: 'interval', timezone: 'UTC', everyMs: HOUR, startAt: NOW, endAt: NOW + 3 * HOUR }, timezone: 'UTC', startAt: NOW, endAt: NOW + 3 * HOUR, nextFireAt: NOW + HOUR,
    chatId: CHAT, createdBy: CREATOR, name: 'synthetic identity task', taskText: 'identity-case:automatic', cwd: tmp.workspace });
  const agent = createRuntimeAgent(cfg, { profileDir: tmp.profile, rootDir: tmp.root, profile: 'synthetic', larkCliConfigDir: configDir, larkCliSourceConfigFile: env.LARK_CHANNEL_CONFIG });
  const channel = createRecordingLarkChannel({ chats: [{ id: CHAT, name: 'Synthetic' }], chatMode: options.chatMode ?? 'group', botIdentity: { openId: 'ou_synthetic_bot', name: 'Synthetic' } });
  sdk.channel = channel;
  const bridge = await startChannel({ appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') }, cfg, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), automations: store, journal, now: () => now, probe: async () => true,
    controls: { profile: 'synthetic', profileConfig: cfg, cfg, botOwnerId: CREATOR, ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: 'synthetic-identity' },
  });
  cleanup.push(() => bridge.disconnect());
  const waits = new AbortController();
  cleanup.push(async () => waits.abort());
  const bodies = () => channel.sent.map(row => {
    const content = row.content as { text?: string; markdown?: string };
    return content.text ?? content.markdown ?? JSON.stringify(content);
  }).join('\n');
  return {
    tmp, cli, cfg, store, journal, bridge, channel, configDir, env, bodies,
    waitForFile: (path: string, accepts?: (content: string) => boolean) => waitForFile(path, accepts, waits.signal),
    fire: async () => { now = NOW + HOUR; await bridge.wakeAutomation(formatFireKey(1, now)); },
    settled: async () => {
      await waitForFile(store.getFilePath(), content => {
        const item = JSON.parse(content).items.find((row: { id: number }) => row.id === 1);
        return /^(ok|failed)$/.test(item?.lastStatus);
      }, waits.signal);
      expect(store.get(1)?.lastStatus).toMatch(/^(ok|failed)$/);
    },
    calls: () => jsonLines<{ args: string[]; env: typeof env }>(join(cli.directory, 'calls.jsonl')),
    runs: () => jsonLines<{ id: string; systemPrompt: string; prompt: string; resumed: boolean; hasToolConnection: boolean }>(join(cli.directory, 'runs.jsonl')),
    message: (id: string, reply?: string) => channel.handlers.message?.({
      messageId: `om_synthetic_${id}`, content: `identity-case:${id}`, chatId: CHAT, chatType: 'group',
      senderId: CREATOR, senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now, raw: { sender: { sender_type: 'user' } },
      ...(reply ? { threadId: reply, rootId: reply, parentId: reply, replyToMessageId: reply } : {}),
    } as unknown as NormalizedMessage),
    async configUnchanged() {
      expect(await readFile(join(configDir, 'config.json'), 'utf8')).toBe(config);
      expect(await readFile(env.LARK_CHANNEL_CONFIG, 'utf8')).toBe(source);
      expect(JSON.stringify(cfg)).toBe(profileBefore);
    },
  };
}

async function jsonLines<T>(file: string): Promise<T[]> {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
