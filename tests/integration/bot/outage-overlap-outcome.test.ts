import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
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
const OWNER = 'ou_owner';
const UNKNOWN_STDERR = [
  'failed to read /Users/someone/.cursor/projects/secret-repo/config.json',
  'account: user@example.com',
].join('\n');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('retriability from outcome shape plus outage overlap', { timeout: 20_000 }, () => {
  it('posts a continue notice with network wording for an unknown stderr failure that overlapped an outage', async () => {
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(mention('om_run', 'please run'));
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();

    run.stderrSnapshot = UNKNOWN_STDERR;
    run.push({
      type: 'error',
      message: `cursor exited with code 1: ${UNKNOWN_STDERR}`,
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await recoverLink(h);
    await waitFor(() => noticeCards(h.channel).length === 1);

    const notice = JSON.stringify(noticeCards(h.channel)[0]?.content);
    expect(notice).toContain('上游网络中断');
    expect(notice).toContain('notice.continue');
    expect(notice).toContain(CONTINUE_HINT);
    expect(notice).not.toContain('/Users/someone/.cursor');
    expect(notice).not.toContain('user@example.com');
    expect(notice).not.toContain('不能继续');
  });

  it('still posts a needs-human auth notice when the failure overlapped an outage', async () => {
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(mention('om_auth', 'please run'));
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();

    const stderr = "Your stored authentication is invalid. Please run 'agent login'.";
    run.stderrSnapshot = stderr;
    run.push({ type: 'error', message: stderr, terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await recoverLink(h);
    await waitFor(() => h.channel.sent.some((item) => item.chatId === OWNER));

    const initiator = h.channel.sent.filter((item) => (
      item.chatId === CHAT && JSON.stringify(item.content).includes('不能继续')
    ));
    expect(initiator).toHaveLength(1);
    expect(JSON.stringify(initiator[0]?.content)).not.toContain('notice.continue');
    expect(JSON.stringify(initiator[0]?.content)).not.toContain('上游网络中断');
    expect(h.channel.sent.filter((item) => item.chatId === OWNER)).toHaveLength(1);
    expect(noticeCards(h.channel)).toHaveLength(0);
  });

  it('offers continue with network wording when the run started while the link was already down', async () => {
    const h = await harness({ agentKind: 'cursor' });
    await h.channel.handlers.message?.(mention('om_queued', 'please run'));
    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    run.stderrSnapshot = UNKNOWN_STDERR;
    run.push({
      type: 'error',
      message: `cursor exited with code 1: ${UNKNOWN_STDERR}`,
      terminationReason: 'failed',
    });
    run.close();
    run.releaseCleanup();
    await recoverLink(h);
    await waitFor(() => noticeCards(h.channel).length === 1);

    const notice = JSON.stringify(noticeCards(h.channel)[0]?.content);
    expect(notice).toContain('上游网络中断');
    expect(notice).toContain('notice.continue');
  });

  it('still treats a quota failure as needs-human when it overlapped an outage', async () => {
    const h = await harness({ agentKind: 'kimi' });
    await h.channel.handlers.message?.(mention('om_quota', 'please run'));
    await waitFor(() => h.agent.manual.length === 1);
    const run = h.agent.manual[0]!;
    run.push({ type: 'text', delta: 'WORKING' });
    await waitFor(() => rendered(h.channel).includes('WORKING'));

    h.channel.connectionState = 'reconnecting';
    await h.bridge.tickLink();

    const stderr = 'rate limit exceeded for this API key';
    run.stderrSnapshot = stderr;
    run.push({ type: 'error', message: stderr, terminationReason: 'failed' });
    run.close();
    run.releaseCleanup();
    await waitFor(() => rendered(h.channel).includes('额度或速率受限'));

    expect(rendered(h.channel)).toContain('额度或速率受限，需要人工处理');
    expect(noticeCards(h.channel)).toHaveLength(0);
    expect(rendered(h.channel)).not.toContain('notice.continue');
    expect(rendered(h.channel)).not.toContain('上游网络中断');
  });
});

async function harness(opts: { agentKind: 'cursor' | 'kimi' }) {
  const tmp = await createTmpProfile('outage-overlap-outcome-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'));
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: opts.agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT], admins: [USER] },
    preferences: {
      messageReply: 'card',
      showToolCalls: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
    reliability: { notice: true },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new StreamingFakeAgent(opts.agentKind);
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    probe: async () => true,
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls: {
      profile: opts.agentKind,
      profileConfig: cfg,
      cfg,
      botOwnerId: OWNER,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-outage-overlap',
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(async () => {
    for (const run of agent.manual) run.releaseCleanup();
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, agent, bridge };
}

class StreamingFakeAgent extends FakeAgentAdapter {
  readonly manual: ReturnType<typeof manualRun>[] = [];
  constructor(id: string) {
    super({ id });
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
  let cleaned = false;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = () => {
      cleaned = true;
      resolve();
    };
  });
  const run: AgentRun & { stderrSnapshot?: string } = {
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
    waitForExit: async (timeoutMs) => {
      if (cleaned) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          cleanup.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  return {
    run,
    close: () => {
      closed = true;
      notify?.();
    },
    releaseCleanup: release,
    push: (event: AgentEvent) => {
      queue.push(event);
      notify?.();
    },
    set stderrSnapshot(value: string) {
      run.stderrSnapshot = value;
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
  channel: { connectionState: 'connected' | 'reconnecting' | 'failed' };
  bridge: { tickLink(): Promise<void> };
}) {
  h.channel.connectionState = 'connected';
  await h.bridge.tickLink();
}

function rendered(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return JSON.stringify({ sent: channel.sent, streams: channel.streams });
}

function isNoticeContent(content: unknown): boolean {
  const json = JSON.stringify(content);
  return json.includes('notice.continue') || json.includes(CONTINUE_HINT);
}

function noticeCards(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => isNoticeContent(item.content));
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    else await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected outage-overlap outcome transition was not observed');
}
