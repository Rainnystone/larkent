import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { TurnJournal } from '../../../src/bot/turn-journal';
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

const CHAT = 'oc_group';
const USER = 'ou_user';
const ANSWER = 'JOURNAL_FINAL';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('turn journal in the live channel', { timeout: 20_000 }, () => {
  it('marks a failed final send completed-undelivered and resends once on recoverMissed', async () => {
    const h = await harness({ fakeTimers: false });
    let fails = 1;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error('sdk timeout');
      }
      return orig(...args);
    };

    await h.channel.handlers.message?.(mention('om_run', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'completed-undelivered'));
    expect(h.channel.sent).toEqual([]);

    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'reply-delivered'));
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain(ANSWER);

    await h.bridge.recoverMissed();
    expect(h.channel.sent).toHaveLength(1);
  });

  it.each(['/new', '/cd', '/ws use saved', '/resume use sess-1'] as const)(
    'voids the incomplete journal record after %s',
    async (command) => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({ hold, complete: false });
      if (command === '/ws use saved') {
        await h.channel.handlers.message?.(mention('om_save', '/ws save saved'));
        await vi.advanceTimersByTimeAsync(600);
      }
      const text = command === '/cd' ? `/cd ${h.workspace}` : command;

      await h.channel.handlers.message?.(mention('om_run', 'start the run'));
      await vi.advanceTimersByTimeAsync(600);
      await waitFor(() => h.agent.runOptions.length === 1);
      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_run')
        && (entry.status === 'queued' || entry.status === 'running')
      )));

      await h.channel.handlers.message?.(mention('om_switch', text));
      await h.journal.flush();
      expect(
        h.journal.list(),
        `after ${text}: ${JSON.stringify(h.journal.list())}`,
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageIds: expect.arrayContaining(['om_run']), status: 'voided' }),
      ]));
      release();
    },
  );

  it('settles a streamed card turn instead of leaving it running', async () => {
    const h = await harness({ fakeTimers: false, replyMode: 'card' });
    await h.channel.handlers.message?.(mention('om_run', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_run') && entry.status === 'reply-delivered'
    )));
  });

  it('does not mark an in-flight run interrupted on WebSocket reconnected', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ hold, complete: false });
    await h.channel.handlers.message?.(mention('om_run', 'start the run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_run')
      && (entry.status === 'queued' || entry.status === 'running')
    )));
    h.channel.emit('reconnected');
    await yieldIO();
    await h.journal.flush();
    expect(h.journal.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageIds: expect.arrayContaining(['om_run']),
        status: expect.stringMatching(/queued|running/),
      }),
    ]));
    release();
  });

  it('does not write or recover when journal write is off', async () => {
    const h = await harness({ journal: false });
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async () => {
      throw new Error('sdk timeout');
    };

    await h.channel.handlers.message?.(mention('om_run', 'please answer'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(() => {
      const run = h.agent.runs[0];
      return Boolean(run?.stopped || (run !== undefined && run.waitForExitCalls > 0));
    });
    await h.journal.flush();
    await expect(readFile(h.file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    h.channel.send = orig;
    await h.bridge.recoverMissed();
    expect(h.channel.sent).toEqual([]);
  });
});

async function harness(opts: {
  hold?: Promise<void>;
  journal?: boolean;
  complete?: boolean;
  fakeTimers?: boolean;
  replyMode?: 'text' | 'card';
} = {}) {
  const tmp = await createTmpProfile('turn-journal-');
  const file = join(tmp.profile, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  const cfg = profile(tmp.workspace, opts.journal, opts.replyMode);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const complete = opts.complete !== false;
  const agent = new FakeAgentAdapter({
    id: 'claude',
    hold: opts.hold,
    waitForExit: complete,
    events: complete
      ? [[{
        type: 'text',
        delta: ANSWER,
      }, {
        type: 'final_text',
        content: ANSWER,
      }, {
        type: 'done',
        terminationReason: 'normal',
        resumeHandle: 'sess-1',
      }]]
      : [[{ type: 'system', resumeHandle: 'sess-hold' }]],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-journal',
    },
  });
  if (opts.fakeTimers !== false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    bridge,
    agent,
    journal,
    file,
    workspace: tmp.workspace,
  };
}

function profile(workspace: string, journal?: boolean, replyMode: 'text' | 'card' = 'text') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: replyMode,
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
    ...(journal === false ? { reliability: { journal: false } } : {}),
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function mention(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    else await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected turn-journal transition was not observed');
}
