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

interface PatchCalls {
  n: number;
  notify?: () => void;
}

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
    const patchCalls: PatchCalls = { n: 0 };

    try {
      const h = await harness(patchCalls);
      const runStarted = waitUntilRun(h.agent);
      const patched = waitUntilPatched(patchCalls);
      const finalPatch = waitUntilLogged(fail, 'stream', 'final-patch');
      await h.channel.handlers.message?.(mention('om_t17', 'please answer'));
      const run = await runStarted;
      run.push({ type: 'text', delta: ANSWER });
      await patched;
      expect(rejections, String(rejections[0])).toEqual([]);

      run.push({ type: 'final_text', content: ANSWER });
      run.push({ type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' });
      run.close();
      run.releaseCleanup();

      await finalPatch;
      expect(rejections, String(rejections[0])).toEqual([]);
      expect(h.journal.list().some((entry) => (
        entry.messageIds.includes('om_t17') && entry.status === 'completed-undelivered'
      ))).toBe(true);

      const delivered = waitUntilReplyDelivered(h.journal, 'om_t17');
      const cardPatched = waitUntilCardAnswer(h.channel);
      await recoverLink(h);
      await delivered;
      await cardPatched;
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

async function harness(patchCalls: PatchCalls) {
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
  patchCalls: PatchCalls,
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
            patchCalls.notify?.();
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
  notifyRun?: () => void;
  constructor() {
    super({ id: 'claude' });
  }
  override run(opts: AgentRunOptions): AgentRun {
    const recorded = super.run(opts);
    const manual = manualRun(recorded);
    this.manual.push(manual);
    this.notifyRun?.();
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

function waitUntilRun(agent: StreamingFakeAgent): Promise<ReturnType<typeof manualRun>> {
  if (agent.manual[0]) return Promise.resolve(agent.manual[0]);
  return new Promise((resolve) => {
    agent.notifyRun = () => {
      const run = agent.manual[0];
      if (run) resolve(run);
    };
  });
}

function waitUntilPatched(patchCalls: PatchCalls): Promise<void> {
  if (patchCalls.n >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    patchCalls.notify = resolve;
  });
}

function waitUntilLogged(
  fail: {
    mock: { calls: ReadonlyArray<readonly [string, unknown, { step?: unknown }?]> };
    mockImplementation(impl: typeof log.fail): unknown;
  },
  phase: string,
  step: string,
): Promise<void> {
  const matches = (loggedPhase: string, fields?: { step?: unknown }): boolean => (
    loggedPhase === phase && fields?.step === step
  );
  if (fail.mock.calls.some(([loggedPhase, , fields]) => matches(loggedPhase, fields))) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    fail.mockImplementation((loggedPhase, _err, fields) => {
      if (matches(loggedPhase, fields)) resolve();
    });
  });
}

function waitUntilReplyDelivered(journal: TurnJournal, messageId: string): Promise<void> {
  const delivered = (): boolean => journal.list().some((entry) => (
    entry.messageIds.includes(messageId) && entry.status === 'reply-delivered'
  ));
  if (delivered()) return Promise.resolve();
  const previous = journal.replyDelivered.bind(journal);
  return new Promise((resolve) => {
    journal.replyDelivered = ((turnId: string, id?: string) => {
      previous(turnId, id);
      if (delivered()) resolve();
    }) as TurnJournal['replyDelivered'];
  });
}

function waitUntilCardAnswer(
  channel: ReturnType<typeof createRecordingLarkChannel>,
): Promise<void> {
  const has = (): boolean => channel.updatedCards.some((row) => (
    row.messageId === STREAM_ID && JSON.stringify(row.card).includes(ANSWER)
  ));
  if (has()) return Promise.resolve();
  const previous = channel.updateCard.bind(channel);
  return new Promise((resolve, reject) => {
    channel.updateCard = (async (
      ...args: Parameters<typeof channel.updateCard>
    ) => {
      try {
        const result = await previous(...args);
        if (has()) resolve();
        return result;
      } catch (err) {
        reject(err);
        throw err;
      }
    }) as typeof channel.updateCard;
  });
}
