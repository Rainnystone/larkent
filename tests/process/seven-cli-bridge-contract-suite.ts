import { draftConfirmationDelivery } from '../../src/automations/draft-confirmation';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions } from '../../src/agent/types';
import { AutomationsStore } from '../../src/automations/store';
import { TurnJournal } from '../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { createRuntimeAgent } from '../../src/runtime/agent-runtime';
import { SessionCatalog } from '../../src/session/catalog';
import { SessionStore } from '../../src/session/store';
import { WorkspaceStore } from '../../src/workspace/store';
import { automationButton, automationClick } from '../helpers/automation-tool-harness';
import { installBridgeContractCli } from '../helpers/bridge-contract-cli';
import type { buildToolProcess } from '../helpers/bridge-tool-process';
import { writeExternalPlugin } from '../helpers/external-plugin';
import { createRecordingLarkChannel } from '../helpers/recording-lark-channel';
import type { PinAgentKind } from '../helpers/scripted-jsonl-cli';
import { createTmpProfile } from '../helpers/tmp-profile';
import type { startChannel as sourceStartChannel } from '../../src/bot/channel';

const NOW = Date.parse('2026-10-19T00:00:00Z');
// Seven contract files run concurrently on CI. Windows file scanning can make a
// local tool round-trip slow enough to hit the client's production 10s timeout.
process.env.LARK_BRIDGE_TOOL_TIMEOUT_MS = process.platform === 'win32' ? '120000' : '60000';
// Seven runtime turns and 90+ real client processes share a row. Hosted Windows
// reached the final stop phase at the old 120s limit; the per-agent files now run
// these process-heavy rows in parallel workers, so each Windows turn needs a
// wider budget than the single-file run did.
const CONTRACT_ROW_TIMEOUT_MS = process.platform === 'win32' ? 600_000 : 240_000;
const TURN_WAIT_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 30_000;
const CORRECTED_PREVIEW = [
  { category: 'needs-input', code: 'missing-end-at' },
  { category: 'ok', data: { totalCount: 3, local: { nextFires: ['2026-10-19 09:00', '2026-10-20 09:00', '2026-10-21 09:00'] } } },
];

function expectResumeArgv(kind: PinAgentKind, argv: string[], handle?: string, acp?: {method:string;params:{sessionId?:string}}) {
  if (kind === 'devin') {
    expect(argv).toContain('acp'); expect(argv).not.toContain('-r');
    expect(acp?.method).toBe(handle ? 'session/load' : 'session/new');
    expect(acp?.params.sessionId).toBe(handle);
    return;
  }
  const flag = { claude: '--resume', codex: 'resume', kimi: '-S', grok: '-r', cursor: '--resume', antigravity: '--conversation', devin: '-r' }[kind];
  if (!handle) { expect(argv).not.toContain(flag); return; }
  expect(argv).toContain(flag);
  if (kind === 'codex') expect(argv.slice(-2)).toEqual([handle, '-']);
  else expect(argv[argv.indexOf(flag) + 1]).toBe(handle);
}

export interface SevenCliContractDeps {
  kinds: readonly PinAgentKind[];
  getClient: () => Awaited<ReturnType<typeof buildToolProcess>>;
  getStartChannel: () => typeof sourceStartChannel;
  sdk: { channel: ReturnType<typeof createRecordingLarkChannel> | undefined };
  cleanup: Array<() => Promise<unknown>>;
}

// This suite is unconditional on every CI OS. It proves adapter/control-process behavior,
// not native CLI/model tool selection. The paid/live acceptance belongs to P09.
export function registerSevenCliContract(input: SevenCliContractDeps): void {
  it.each(input.kinds)('%s carries the complete shared contract through new/resumed IM, automatic runs and stop', async kind => {
    const client = input.getClient();
    const startChannel = input.getStartChannel();
    const cleanup = input.cleanup;
    const sdk = input.sdk;
    const tmp = await createTmpProfile(`seven cli & ${kind}-`); cleanup.push(tmp.cleanup);
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runtime = await installBridgeContractCli(tmp.root, kind);
    const external = await writeExternalPlugin(join(tmp.root, 'package & scripts with spaces'));
    await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [external] }));
    const nativeHome = join(tmp.root, 'native home'); await mkdir(nativeHome);
    const nativeMarker = join(nativeHome, 'native-plugin.json');
    await writeFile(nativeMarker, '{"syntheticNativePlugin":"enabled"}');
    const cfg = createDefaultProfileConfig({ agentKind: kind, binaryPath: runtime.path,
      accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_synthetic', 'ou_mate'], allowedChats: ['oc_synthetic'] },
      preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' },
      ...(kind === 'codex' ? { codex: { binaryPath: runtime.path, codexHome: nativeHome, inheritCodexHome: false, ignoreUserConfig: false, ignoreRules: false } } : {}),
    });
    if (kind === 'claude' || kind === 'codex') cfg.permissions = { defaultAccess: 'workspace', maxAccess: 'workspace' };
    cfg.automations = { enabled: true, agentTasks: true, timezone: 'Asia/Shanghai' }; cfg.workspaces.default = tmp.workspace;
    const config = join(tmp.root, 'profile & config.json');
    const larkCliConfigDir = join(tmp.profile, 'lark cli & config'); await mkdir(larkCliConfigDir);
    const real = createRuntimeAgent(cfg, { profileDir: tmp.profile, rootDir: tmp.root, profile: 'synthetic', configPath: config, larkCliConfigDir });
    const runs: AgentRunOptions[] = [];
    // Observe the public adapter input without substituting its child, runner, events or results.
    const agent: AgentAdapter = { id: real.id, displayName: real.displayName,
      isAvailable: () => real.isAvailable(), prepareRun: opts => real.prepareRun?.(opts) ?? Promise.resolve(),
      setBotIdentity: identity => real.setBotIdentity?.(identity), run: opts => { runs.push(opts); return real.run(opts); } };
    const journal = new TurnJournal(join(tmp.profile, 'journal.json'), { now: () => now }); await journal.load();
    const store = new AutomationsStore({ journal, path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => now }); await store.load();
    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const sessionCatalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json')); await sessionCatalog.load();
    const channel = createRecordingLarkChannel({ chats: [{ id: 'oc_synthetic', name: 'Synthetic' }], chatMode: 'group' }); sdk.channel = channel;
    const start = () => startChannel({ cfg, agent, sessions, sessionCatalog, journal, automations: store, workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')), now: () => now, probe: async () => true,
      appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
      controls: { profile: 'synthetic', profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: config, processId: 'synthetic-contract' },
    });
    let bridge = await start(); cleanup.push(() => bridge.disconnect());
    let message = 0;
    const send = (content = 'Run the synthetic contract', replyTo?: string) => channel.handlers.message?.({ messageId: `om_contract_${++message}`, content, chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: now,
      ...(replyTo ? { threadId: replyTo, rootId: replyTo, replyToMessageId: replyTo } : {}), raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
    const wait = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: TURN_WAIT_TIMEOUT_MS });
    const finish = async (value = 42) => {
      await wait(async () => { expect((await runtime.report()).connected).toBe(true); });
      await wait(() => expect(journal.list().at(-1)?.reply?.state).toBe('sent'));
      const report = await runtime.report();
      expect(report.script).toEqual({ result: value, doubled: value * 2 });
      expect(report.env).toMatchObject({ LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'synthetic', LARK_CHANNEL_HOME: tmp.root, LARK_CHANNEL_CONFIG: config, LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
        LARK_BRIDGE_TOOL_SCOPE: expect.any(String), LARK_BRIDGE_TOOL_ISSUED_AT: String(now) });
      expect(await realpath(report.env.LARK_BRIDGE_TOOL_CLIENT)).toBe(await realpath(join(client.directory, 'bin/lark-channel-bridge.mjs')));
      expect(await realpath(report.cwd)).toBe(await realpath(tmp.workspace));
      const instructions = JSON.parse(/<bridge_instructions>\n(.*?)\n<\/bridge_instructions>/s.exec(report.prompt)![1]!) as string[];
      report.instructions = instructions.join('\n');
      expect(report.instructions).toContain('<bridge_plugins>');
      expect(report.prompt).toContain('Calculate a synthetic fixture value');
      expect(report.prompt).not.toContain('Read data.json');
      expect(report.prompt).not.toContain(runs.at(-1)!.toolEnv!.LARK_BRIDGE_TOOL_TOKEN);
      expect(report.calls.find((call: any) => call.operation === 'plugins.list' && call.result.category === 'validation-failed').result.code).toBe('unknown-field');
      const revoked = await client.call({ version: 1, operation: 'plugins.list' }, runs.at(-1)!.toolEnv);
      expect(JSON.parse(revoked.stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
      return report;
    };
    const calls = (report: any, operation: string) => report.calls.filter((call: any) => call.operation === operation).map((call: any) => call.result);
    const confirm = async (op: string) => {
      const draft = store.listDrafts()[0]!;
      const card = [...channel.sent].reverse().find(item => JSON.stringify(item.content).includes('auto.confirm'))!;
      expect(await channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card.content, op)))).toMatchObject({ toast: { type: 'success' } });
    };

    await runtime.plan({ mode: 'create', now }); await send();
    const created = await finish();
    expectResumeArgv(kind, created.argv, undefined, created.acpSessionRequest);
    expect(runs[0]!.resumeHandle).toBeUndefined();
    expect(calls(created, 'automation.create')).toMatchObject([{ category: 'validation-failed', code: 'invalid-params' }, { category: 'waiting-confirmation' }, { category: 'waiting-confirmation' }]);
    expect(calls(created, 'automation.preview')).toMatchObject(CORRECTED_PREVIEW);
    const operationId = calls(created, 'automation.operation.get')[0].data.operationId;
    expect(store.list()).toEqual([]); expect(store.listDrafts()).toHaveLength(1);
    await confirm('auto.confirm');
    expect(store.list()).toMatchObject([{ id: 1, taskType: 'agent', taskText: 'literal "\'\n$(synthetic) ; & | <tag> 中🙂', createdBy: 'ou_synthetic' }]);

    await runtime.plan({ mode: 'manage', now, operationId }); await send();
    const managed = await finish();
    expectResumeArgv(kind, managed.argv, created.session, managed.acpSessionRequest);
    expect(runs[1]!.resumeHandle).toBe(created.session);
    expect(calls(managed, 'automation.operation.get')).toMatchObject([{ category: 'applied', data: { executedCount: 0 } }, { category: 'applied' }]);
    expect(calls(managed, 'automation.pause')[0].category).toBe('applied');
    expect(calls(managed, 'automation.resume')[0].category).toBe('applied');
    expect(calls(managed, 'automation.preview')).toMatchObject(CORRECTED_PREVIEW);
    expect(calls(managed, 'automation.replace')[0].category).toBe('waiting-confirmation');
    const replacementId = calls(managed, 'automation.replace')[0].data.operationId;
    await confirm('auto.confirm');

    let automaticSession = ''; let automaticReply = '';
    for (const fireAt of [NOW + 3600000, NOW + 86400000 + 3600000]) {
      now = fireAt; await runtime.plan({ mode: 'automatic', now });
      await bridge.tickLink(); bridge.noteLinkFrame(); await bridge.tickLink();
      const fireKey = `${store.list()[0]!.id}@${fireAt}`;
      await bridge.wakeAutomation(fireKey);
      const automatic = await finish();
      expectResumeArgv(kind, automatic.argv, undefined, automatic.acpSessionRequest);
      expect(runs.at(-1)!.promptVariant).toBe('automation');
      // Scheduled fires intentionally start fresh; they must never reuse an IM or prior-fire handle.
      expect(runs.at(-1)!.resumeHandle).toBeUndefined();
      automaticSession = automatic.session;
      automaticReply = journal.get(`af:${fireKey}`)!.reply!.messageId!;
      expect(automatic.instructions).toContain('"runType":"automation"');
      for (const operation of ['automation.list', 'automation.preview', 'automation.create', 'automation.replace', 'automation.delete', 'automation.pause', 'automation.resume', 'automation.operation.get']) {
        expect(calls(automatic, operation)[0]).toMatchObject({ category: 'unavailable', code: 'automation-management-unavailable-in-run' });
      }
    }
    expect(new Set(runs.map(run => run.toolEnv!.LARK_BRIDGE_TOOL_TOKEN)).size).toBe(4);
    await runtime.plan({ mode: 'delete', now, operationId: replacementId }); await send('Inspect results and delete', automaticReply);
    const deleted = await finish();
    expectResumeArgv(kind, deleted.argv, automaticSession, deleted.acpSessionRequest);
    expect(runs.at(-1)!.resumeHandle).toBe(automaticSession);
    expect(calls(deleted, 'automation.operation.get')[0]).toMatchObject({ category: 'applied', data: { executedCount: 2, deliveredCount: 2, lastExecution: 'ok', lastDelivery: 'sent' } });
    expect(calls(deleted, 'automation.delete')[0]).toMatchObject({ category: 'waiting-confirmation' });
    await confirm('auto.confirm'); expect(store.list()).toEqual([]);

    const reference = calls(created, 'plugins.read')[0].data.source.reference;
    const next = await writeExternalPlugin(join(tmp.root, 'package v2 & scripts'), '2.0.0', 7);
    await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [next] }));
    await bridge.disconnect(); bridge = await start();
    await runtime.plan({ mode: 'read', now, reference }); await send('Read the current plugin version');
    const updated = await finish(7);
    expectResumeArgv(kind, updated.argv, managed.session, updated.acpSessionRequest);
    expect(runs.at(-1)!.resumeHandle).toBe(managed.session);
    expect(updated.instructions).toContain('"version":"2.0.0"');
    expect(calls(updated, 'plugins.read').at(-1)).toMatchObject({ category: 'unavailable', code: 'stale-plugin-reference' });
    const prior = runs[0]!.toolEnv!;
    await runtime.plan({ mode: 'hold', now }); await send();
    await wait(async () => { expect((await runtime.report()).mode).toBe('hold'); });
    const active = runs.at(-1)!.toolEnv!;
    const forged = await client.call({ version: 1, operation: 'plugins.list' }, { ...active, LARK_BRIDGE_TOOL_TOKEN: prior.LARK_BRIDGE_TOOL_TOKEN });
    expect(JSON.parse(forged.stdout)).toMatchObject({ category: 'unauthorized', code: 'invalid-run-credential' });
    await send('/stop');
    expect(JSON.parse((await client.call({ version: 1, operation: 'plugins.list' }, active)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
    expect(await readFile(nativeMarker, 'utf8')).toBe('{"syntheticNativePlugin":"enabled"}');
    if (kind === 'claude') expect(created.argv.slice(created.argv.indexOf('--permission-mode'), created.argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'acceptEdits']);
    if (kind === 'codex') {
      expect(created.argv.slice(created.argv.indexOf('--sandbox'), created.argv.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
      expect(created.env.CODEX_HOME).toBe(nativeHome);
      expect(managed.argv).not.toContain('--ignore-user-config'); expect(managed.argv).not.toContain('--ignore-rules');
    }
  }, CONTRACT_ROW_TIMEOUT_MS);
}
