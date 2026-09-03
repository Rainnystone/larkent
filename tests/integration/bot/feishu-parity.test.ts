import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  PIN_PROMPT,
  PINNED_AGENT_KINDS,
  assertGoldenFile,
  createPinnedAdapter,
  createRecordingLarkChannel,
  sanitizePinValue,
  scriptedJsonlLines,
  scriptedVersion,
  waitForQuietCalls,
  type PinnedAgentKind,
  type RecordingLarkChannel,
  type ScriptedScenario,
} from '../../helpers/scripted-jsonl-cli.js';
import { writeScriptedJsonlExecutable } from '../../helpers/fake-executable.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channels: new Map<string, RecordingLarkChannel>(),
  createLarkChannel: vi.fn((opts: { appId?: string }) => {
    const channel = sdkMock.channels.get(opts.appId ?? '');
    if (!channel) throw new Error(`recording channel missing for ${opts.appId}`);
    return channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channels.clear();
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.sequential('P1 Feishu surface parity', () => {
  it.each(PINNED_AGENT_KINDS)('pins channel-call sequence for %s', async (kind) => {
    const happy = await captureParity(kind, 'happy');
    const error = await captureParity(kind, 'error');
    assertGoldenFile(join(process.cwd(), 'tests/fixtures/goldens/feishu-parity', `${kind}.json`), {
      kind,
      happy,
      error,
    });
  }, 20_000);
});

async function captureParity(kind: PinnedAgentKind, scenario: ScriptedScenario): Promise<unknown> {
  const tmp = await createTmpProfile(`feishu-parity-${kind}-${scenario}-`);
  const channel = createRecordingLarkChannel();
  const appId = `cli_pin_${kind}_${scenario}`;
  sdkMock.channels.set(appId, channel);
  const fake = await writeScriptedJsonlExecutable(join(tmp.root, 'bin', kind), {
    lines: scriptedJsonlLines(kind, scenario),
    version: scriptedVersion(kind),
    ...(scenario === 'error' ? { stderr: 'boom\n', exitCode: 1 } : {}),
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: appId, secret: 'secret', tenant: 'feishu' } },
    preferences: { messageReply: 'card' },
    ...(kind === 'codex' ? { codex: { binaryPath: fake.path } } : {}),
  });
  profileConfig.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = createPinnedAdapter(kind, fake.path, tmp.profile);
  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    sessionCatalog: catalog,
    workspaces,
    controls: {
      profile: kind,
      profileConfig,
      ownerRefreshState: 'ok',
      botOwnerId: 'ou_owner',
      ownerRefreshedAt: 1_700_000_000_000,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.profile, 'config.json'),
      cfg: profileConfig,
      processId: `proc_${kind}`,
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  await channel.handlers.message?.(p2pMessage(`om_${kind}_${scenario}`, PIN_PROMPT));
  await waitForQuietCalls(channel);

  expect(channel.calls.length).toBeGreaterThan(0);
  const root = await realpath(tmp.root);
  const workspace = await realpath(tmp.workspace);
  return sanitizePinValue(channel.calls, [
    [root, '<tmp-root>'],
    [tmp.root, '<tmp-root>'],
    [workspace, '<workspace>'],
    [tmp.workspace, '<workspace>'],
  ]);
}

function p2pMessage(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1_700_000_001_000,
  } as unknown as NormalizedMessage;
}
