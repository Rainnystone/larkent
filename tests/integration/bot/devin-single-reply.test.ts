import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { DevinTranscriptTranslator } from '../../../src/agent/devin/transcript.js';
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

const NARRATION = 'Let me look that up.';
const ANSWER = 'The total comes to four apples.';
const USER = 'test-user';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdk.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const chunk = (text: string, messageId: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  _meta: { 'cognition.ai/messageId': messageId },
});

function translate(updates: readonly unknown[]): AgentEvent[] {
  const t = new DevinTranscriptTranslator();
  return [...updates.flatMap((u) => t.translate(u)), ...t.finish('end_turn')];
}

const scripts = {
  'answer-only': () => translate([chunk('The total comes ', 'm1'), chunk('to four apples.', 'm1')]),
  'narration -> tool -> answer': () => translate([
    chunk(NARRATION, 'm1'),
    { sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'execute', rawInput: { command: 'ls' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'apples.txt' },
    chunk('The total comes ', 'm2'),
    chunk('to four apples.', 'm2'),
  ]),
};

describe('Devin final-answer delivery', () => {
  it.each([
    ['markdown', 'answer-only'],
    ['markdown', 'narration -> tool -> answer'],
    ['card', 'answer-only'],
    ['card', 'narration -> tool -> answer'],
  ] as const)('%s mode, %s: the answer appears in exactly one message', async (mode, script) => {
    const h = await harness(mode, scripts[script]());

    await h.channel.handlers.message?.(message(`msg-${mode}`, 'how many apples?'));
    await waitFor(() => JSON.stringify(h.channel.sent).includes(ANSWER));
    await settle();

    const visible = [
      ...h.channel.sent.map((m) => JSON.stringify(m.content)),
      ...h.channel.streams.map((s) => JSON.stringify([s.cardUpdates, s.markdownContents])),
    ];
    expect(visible.filter((body) => body.includes(ANSWER))).toHaveLength(1);
    if (script === 'answer-only') {
      expect(h.channel.streams).toHaveLength(0);
    } else {
      expect(JSON.stringify(h.channel.streams)).toContain(NARRATION);
      expect(JSON.stringify(h.channel.sent)).not.toContain(NARRATION);
    }
  }, 15_000);
});

async function harness(mode: 'markdown' | 'card', events: AgentEvent[]) {
  const tmp = await createTmpProfile(`devin-single-reply-${mode}-`);
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'devin',
    accounts: { app: { id: 'test-app', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER] },
    preferences: {
      messageReply: mode,
      messageReplyMigrated: true,
      cotMessages: 'off',
      showToolCalls: false,
    },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'devin', displayName: 'Devin', events });
  const channel = createRecordingLarkChannel();
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    workspaces,
    controls: {
      profile: 'devin',
      profileConfig,
      ownerRefreshState: 'unknown',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      cfg: profileConfig,
      processId: 'proc-devin',
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
    chatId: 'test-chat',
    chatType: 'p2p',
    senderId: USER,
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
  throw new Error('timed out waiting for devin final reply');
}
