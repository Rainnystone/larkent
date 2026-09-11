import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { AGENT_KINDS, type AgentKind } from '../../../src/agent/registry.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
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

const CHAT = 'oc_trigger';
const MSG = 'om_batch_1';
const ANSWER = 'PINNED_ANSWER';
const SEND_CMD = `lark-cli im +messages-send --chat-id ${CHAT} --text already delivered`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdk.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('skip final reply when the agent already IM-sent to this chat', () => {
  it.each(AGENT_KINDS)('%s successful CLI send → no extra final post', async (kind) => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness(kind, scriptedSend(true), 'text');

    await h.channel.handlers.message?.(message(MSG, 'please answer'));
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'skip-cli-already-sent'),
    );

    expect(h.channel.sent).toEqual([]);
    expect(info.mock.calls).toContainEqual([
      'outbound',
      'skip-cli-already-sent',
      expect.objectContaining({ scope: expect.any(String), chatId: CHAT, mode: 'text' }),
    ]);
  }, 15_000);

  it.each(AGENT_KINDS)('%s failed CLI send → bridge posts the final as today', async (kind) => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness(kind, scriptedSend(false), 'text');

    await h.channel.handlers.message?.(message(MSG, 'please answer'));
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(() => h.channel.sent.some((row) => JSON.stringify(row.content).includes(ANSWER)));

    expect(JSON.stringify(h.channel.sent)).toContain(ANSWER);
    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'skip-cli-already-sent'),
    ).toBe(false);
  }, 15_000);

  it.each(['card', 'markdown', 'text'] as const)(
    'final-answer-only adapter skips the extra final post in %s mode',
    async (mode) => {
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      const h = await harness('codex', scriptedSend(true), mode);

      await h.channel.handlers.message?.(message(MSG, 'please answer'));
      await waitFor(() => h.agent.runs.length === 1);
      await waitFor(() =>
        info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'skip-cli-already-sent'),
      );

      expect(h.channel.sent.filter((row) => JSON.stringify(row.content).includes(ANSWER))).toEqual([]);
    },
    15_000,
  );

  it('still posts the notice when the run ends in error after a successful CLI send', async () => {
    const h = await harness(
      'claude',
      [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: SEND_CMD },
        },
        { type: 'tool_result', id: 'tool-1', output: '{"code":0}', isError: false },
        { type: 'error', message: 'boom', terminationReason: 'failed' },
      ],
      'text',
    );

    await h.channel.handlers.message?.(message(MSG, 'please answer'));
    await waitFor(() => h.channel.sent.length > 0);
    expect(JSON.stringify(h.channel.sent)).toContain('boom');
  }, 15_000);
});

function scriptedSend(success: boolean): AgentEvent[] {
  return [
    {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: SEND_CMD },
    },
    {
      type: 'tool_result',
      id: 'tool-1',
      output: success ? '{"code":0,"data":{"message_id":"om_sent"}}' : '{"code":99991663,"msg":"denied"}',
      isError: !success,
    },
    { type: 'text', delta: ANSWER },
    { type: 'final_text', content: ANSWER },
    { type: 'done', terminationReason: 'normal' },
  ];
}

async function harness(
  kind: AgentKind,
  events: AgentEvent[],
  messageReply: 'card' | 'markdown' | 'text',
) {
  const tmp = await createTmpProfile(`skip-cli-sent-${kind}-`);
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: `cli_${kind}`, secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: {
      messageReply,
      messageReplyMigrated: true,
      cotMessages: 'off',
      showToolCalls: false,
    },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: kind, displayName: kind, events });
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
    chatId: CHAT,
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

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for skip-cli-already-sent behaviour');
}
