import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { log } from '../../../src/core/logger';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const PATCH_ERR = new Error(
  'failed to get tenant_access_token, code: 10014, msg: app secret invalid',
);

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
  createReal: undefined as ((opts: LarkChannelOptions) => unknown) | undefined,
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  sdk.createReal = actual.createLarkChannel;
  return {
    ...actual,
    createLarkChannel: () => {
      if (!sdk.channel) throw new Error('fake channel not configured');
      return sdk.channel;
    },
  };
});

import { startChannel } from '../../../src/bot/channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
const ANSWER = 'STREAM_FINAL';
const STREAM_ID = 'om_prog1234';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('larkent card path with failing progress patches', { timeout: 20_000 }, () => {
  it('stages and recovers the final reply when progress-card patches fail during the run', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const patchCalls = { n: 0 };

    try {
      const h = await harness(patchCalls);
      await h.channel.handlers.message?.(mention('om_t17', 'please answer'));
      await waitFor(() => h.agent.manual.length === 1);
      const run = h.agent.manual[0]!;
      run.push({ type: 'text', delta: ANSWER });
      await waitFor(() => patchCalls.n >= 1);
      expect(rejections, String(rejections[0])).toEqual([]);

      run.push({ type: 'final_text', content: ANSWER });
      run.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' });
      run.close();
      run.releaseCleanup();

      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_t17')
        && (entry.status === 'completed-undelivered' || entry.status === 'reply-delivered')
      )));
      expect(rejections, String(rejections[0])).toEqual([]);
      expect(fail.mock.calls.some((call) => (
        call[0] === 'stream'
        && (call[2] as { step?: string } | undefined)?.step === 'final-patch'
      ))).toBe(true);

      if (h.journal.list().some((entry) => (
        entry.messageIds.includes('om_t17') && entry.status === 'completed-undelivered'
      ))) {
        await recoverLink(h);
      }
      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_t17') && entry.status === 'reply-delivered'
      )));
      expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER))).toHaveLength(0);
      expect(
        h.channel.updatedCards.some((row) => (
          row.messageId === STREAM_ID && JSON.stringify(row.card).includes(ANSWER)
        )),
        JSON.stringify(h.channel.updatedCards),
      ).toBe(true);
      expect(rejections, String(rejections[0])).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

async function harness(patchCalls: { n: number }) {
  const tmp = await createTmpProfile('progress-card-patch-');
  const file = join(tmp.profile, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  const cfg = profile(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent();
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
  });
  attachFailingCardStream(channel, patchCalls);
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    probe: async () => true,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-progress-card-patch',
    },
  });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, journal, agent };
}

function attachFailingCardStream(
  recording: ReturnType<typeof createRecordingLarkChannel>,
  patchCalls: { n: number },
): void {
  if (!sdk.createReal) throw new Error('real createLarkChannel is not available');
  const real = sdk.createReal({
    appId: 'cli_test',
    appSecret: 'test',
    outbound: {
      retry: { maxAttempts: 1 },
      streamThrottleMs: 10,
      streamThrottleChars: 1,
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      trace() {},
    },
  }) as unknown as {
    sender: { client: unknown };
    stream: ReturnType<typeof createRecordingLarkChannel>['stream'];
  };
  real.sender.client = {
    im: {
      v1: {
        message: {
          create: async () => ({ data: { message_id: STREAM_ID } }),
          reply: async () => ({ data: { message_id: STREAM_ID } }),
          patch: async () => {
            patchCalls.n += 1;
            throw PATCH_ERR;
          },
        },
      },
    },
  };
  recording.stream = real.stream.bind(real);
}

function profile(workspace: string) {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'card',
      messageReplyMigrated: true,
      showToolCalls: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor() {
    super({ id: 'claude' });
  }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded);
    this.manual.push(manual);
    return manual.run;
  }
}

function manualRun(recorded: AgentRun) {
  const queue: AgentEvent[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = (): void => {
    closed = true;
    notify?.();
  };
  const run: AgentRun = {
    runId: recorded.runId,
    events: (async function* () {
      for (;;) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    })(),
    stop: async () => {
      await recorded.stop();
      release();
      await cleanup;
    },
    waitForExit: async (timeoutMs) => recorded.waitForExit(timeoutMs),
  };
  return {
    run,
    close,
    releaseCleanup: release,
    push: (event: AgentEvent) => {
      queue.push(event);
      notify?.();
    },
  };
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

async function recoverLink(h: {
  bridge: { tickLink(): Promise<void>; recoverMissed(): Promise<void> };
}) {
  await h.bridge.tickLink();
  await h.bridge.recoverMissed();
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('expected progress-card patch-failure transition was not observed');
}
