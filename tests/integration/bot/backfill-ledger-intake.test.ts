import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import * as logger from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('processed ledger claim at intake', () => {
  it('runs a repeated message id once and logs intake.skip-duplicate for the loser', async () => {
    const h = await harness();
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const report = vi.spyOn(logger, 'reportMetric').mockImplementation(() => {});
    const msg = mention('om_dup', 'hello once');

    await Promise.all([h.channel.handlers.message?.(msg), h.channel.handlers.message?.(msg)]);

    const events = intakeEvents(info);
    expect(events.filter((row) => row.event === 'queued')).toEqual([
      { event: 'queued', scope: 'oc_group' },
    ]);
    expect(events.filter((row) => row.event === 'skip-duplicate')).toEqual([
      { event: 'skip-duplicate', msgId: 'om_dup', scope: 'oc_group', source: 'ws' },
    ]);
    expect(report.mock.calls.filter(([name]) => name === 'intake_duplicate_dropped')).toEqual([
      ['intake_duplicate_dropped', 1, { source: 'ws' }],
    ]);

    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('hello once');
  });

  it('does not persist a gated-out message, then accepts the same id when it later passes', async () => {
    const h = await harness();
    await h.channel.handlers.message?.(mention('om_gated', 'no mention', { mentionedBot: false }));
    await h.ledger.flush();
    await expect(readFile(h.file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.ledger.has('om_gated')).toBe(false);

    const accepted = mention('om_gated', 'now mentioned');
    await h.channel.handlers.message?.(accepted);
    await h.ledger.flush();
    expect(JSON.parse(await readFile(h.file, 'utf8')).processed).toEqual({
      om_gated: accepted.createTime,
    });
  });

  it('records a handled command so a later delivery of the same id is skipped', async () => {
    const h = await harness();
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const command = mention('om_cmd', '/status');
    await h.channel.handlers.message?.(command);
    expect(intakeEvents(info).map((row) => row.event)).toEqual(['command']);
    await h.ledger.flush();
    expect(JSON.parse(await readFile(h.file, 'utf8')).processed.om_cmd).toBe(command.createTime);

    await h.channel.handlers.message?.(mention('om_cmd', '/status'));
    expect(intakeEvents(info)).toContainEqual({
      event: 'skip-duplicate',
      msgId: 'om_cmd',
      scope: 'oc_group',
      source: 'ws',
    });
  });

  it('keeps exactly one run when the same id is delivered again after a bridge rebuild on the same ledger', async () => {
    const tmp = await createTmpProfile('ledger-restart-');
    const file = join(tmp.profile, 'backfill-state.json');
    const ledger = new BackfillLedger(file);
    await ledger.load();
    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
    const agent = new FakeAgentAdapter({ id: 'claude' });
    const cfg = profile(tmp.workspace);
    const firstChannel = createRecordingLarkChannel();
    sdk.channel = firstChannel;
    const first = await startChannel({
      cfg,
      agent,
      sessions,
      workspaces,
      ledger,
      controls: controls(tmp.root, cfg),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    cleanups.push(async () => {
      await first.disconnect().catch(() => {});
      await tmp.cleanup();
    });

    const live = mention('om_restart', 'across restart');
    await firstChannel.handlers.message?.(live);
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => agent.runOptions.length === 1);

    await first.disconnect();
    const secondChannel = createRecordingLarkChannel();
    sdk.channel = secondChannel;
    const second = await startChannel({
      cfg,
      agent,
      sessions,
      workspaces,
      ledger,
      controls: controls(tmp.root, cfg),
    });
    cleanups.push(async () => { await second.disconnect().catch(() => {}); });

    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    await secondChannel.handlers.message?.(mention('om_restart', 'across restart'));
    await vi.advanceTimersByTimeAsync(600);
    expect(agent.runOptions).toHaveLength(1);
    expect(intakeEvents(info)).toContainEqual({
      event: 'skip-duplicate',
      msgId: 'om_restart',
      scope: 'oc_group',
      source: 'ws',
    });
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).processed.om_restart).toBe(live.createTime);
  });
});

async function harness() {
  const tmp = await createTmpProfile('ledger-intake-');
  const file = join(tmp.profile, 'backfill-state.json');
  const ledger = new BackfillLedger(file);
  await ledger.load();
  const cfg = profile(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    ledger,
    controls: controls(tmp.root, cfg),
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, agent, ledger, file };
}

function profile(workspace: string) {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], admins: ['ou_user'] },
    preferences: { messageReply: 'text', cotMessages: 'off', requireMentionInGroup: true },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function controls(root: string, cfg: ReturnType<typeof profile>) {
  return {
    profile: 'test',
    profileConfig: cfg,
    cfg,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(root, 'config.json'),
    processId: 'test-ledger',
  };
}

function mention(
  messageId: string,
  content: string,
  extra: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    ...extra,
    mentionedBot: extra.mentionedBot ?? true,
    createTime: extra.createTime ?? Date.now(),
  } as NormalizedMessage;
}

function intakeEvents(info: { mock: { calls: unknown[][] } }) {
  return info.mock.calls
    .filter((call): call is [string, string, { msgId?: string; scope?: string; source?: string }?] => (
      call[0] === 'intake' && (call[1] === 'queued' || call[1] === 'skip-duplicate' || call[1] === 'command')
    ))
    .map(([, event, fields]) => {
      const row = fields ?? {};
      if (event === 'skip-duplicate') {
        return { event, msgId: row.msgId, scope: row.scope, source: row.source };
      }
      if (event === 'queued') {
        return { event, scope: row.scope };
      }
      return { event };
    });
}

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected intake transition was not observed');
}
