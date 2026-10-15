import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: () => {
      if (!sdk.channel) throw new Error('recording channel not configured');
      return sdk.channel;
    },
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const PROGRESS = 'status is OK';
const FINAL = 'OK';
const ANSWER = 'the answer';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdk.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('dedicated final vs progress stream', () => {
  it('sends finalText even when it is a substring of progress text', async () => {
    const h = await harness('codex', [
      { type: 'text', delta: PROGRESS },
      { type: 'final_text', content: FINAL },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await h.channel.handlers.message?.(message('om_sub', 'run'));
    await waitFor(() => JSON.stringify(h.channel.streams).includes(PROGRESS));
    await waitFor(() => JSON.stringify(h.channel.sent).includes(FINAL));

    expect(JSON.stringify(h.channel.streams)).toContain(PROGRESS);
    expect(JSON.stringify(h.channel.sent)).toContain(FINAL);
  }, 15_000);

  it.each([
    {
      name: 'interrupted',
      events: [
        { type: 'text' as const, delta: ANSWER },
        { type: 'done' as const, terminationReason: 'interrupted' as const },
      ],
      note: '已被中断',
    },
    {
      name: 'timeout',
      events: [
        { type: 'text' as const, delta: ANSWER },
        { type: 'done' as const, terminationReason: 'timeout' as const },
      ],
      note: '运行超时',
    },
  ])('does not post a standalone $name note after the stream already showed it', async (row) => {
    const h = await harness('claude', row.events);

    await h.channel.handlers.message?.(message('om_note', 'run'));
    await waitFor(() => JSON.stringify(h.channel.streams).includes(row.note));
    await waitFor(() => JSON.stringify(h.channel.streams).includes(ANSWER));
    await settle();

    expect(JSON.stringify(h.channel.streams)).toContain(row.note);
    expect(JSON.stringify(h.channel.sent)).not.toContain(row.note);
  }, 15_000);
});

async function harness(kind: 'codex' | 'claude', events: FakeAgentEvents) {
  const tmp = await createTmpProfile(`final-reply-dedup-${kind}-`);
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `cli_${kind}`, secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: {
      messageReply: 'card',
      messageReplyMigrated: true,
      cotMessages: 'off',
      showToolCalls: false,
    },
    ...(kind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex', inheritCodexHome: false } }
      : {}),
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: kind,
    displayName: kind,
    events,
  });
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    workspaces,
    controls: {
      profile: kind,
      profileConfig,
      ownerRefreshState: 'unknown',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      cfg: profileConfig,
      processId: `proc_${kind}`,
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dedup',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function settle(): Promise<void> {
  for (let n = 0; n < 8; n++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for final-reply-dedup behaviour');
}
