import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { Supervisor } from '../../../src/runtime/supervisor.js';
import type { SessionCatalogEntry } from '../../../src/session/catalog.js';
import { writeScriptedJsonlExecutable } from '../../helpers/fake-executable.js';
import {
  PIN_PROMPT,
  createRecordingLarkChannel,
  envBinVar,
  pinnedDisplayName,
  readScriptedRecords,
  scriptedCatalogHandle,
  scriptedJsonlLines,
  scriptedVersion,
  waitForQuietCalls,
  waitUntil,
  withProcessEnv,
  type RecordingLarkChannel,
  type ScriptedCatalogHandle,
} from '../../helpers/scripted-jsonl-cli.js';

const PAIRS = [
  ['kimi', 'grok'],
  ['cursor', 'kimi'],
] as const;

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

const roots: string[] = [];
const supervisors: Supervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((sup) => sup.shutdown()));
  sdkMock.channels.clear();
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential('P6 multi-bot isolation', () => {
  it.each(PAIRS)('a mention in %s never reaches %s', async (kindA, kindB) => {
    const root = await mkdtemp(join(tmpdir(), `pin-isolation-${kindA}-${kindB}-`));
    roots.push(root);
    const binDir = join(root, 'bin');
    const workspaceA = join(root, 'workspaces', kindA);
    const workspaceB = join(root, 'workspaces', kindB);
    await Promise.all([
      mkdir(join(root, 'profiles', kindA), { recursive: true }),
      mkdir(join(root, 'profiles', kindB), { recursive: true }),
      mkdir(join(workspaceA, '.git'), { recursive: true }),
      mkdir(join(workspaceB, '.git'), { recursive: true }),
    ]);

    const fakeA = await writeScriptedJsonlExecutable(join(binDir, kindA), {
      lines: scriptedJsonlLines(kindA, 'happy'),
      version: scriptedVersion(kindA),
    });
    const fakeB = await writeScriptedJsonlExecutable(join(binDir, kindB), {
      lines: scriptedJsonlLines(kindB, 'happy'),
      version: scriptedVersion(kindB),
    });

    const profileA = profileFor(kindA, `cli_iso_${kindA}`, workspaceA);
    const profileB = profileFor(kindB, `cli_iso_${kindB}`, workspaceB);
    const configPath = join(root, 'config.json');
    const rc = createRootConfig(kindA, profileA);
    rc.profiles[kindB] = profileB;
    await saveRootConfig(rc, configPath);

    const channelA = createRecordingLarkChannel({ openId: `ou_${kindA}`, name: pinnedDisplayName(kindA) });
    const channelB = createRecordingLarkChannel({ openId: `ou_${kindB}`, name: pinnedDisplayName(kindB) });
    sdkMock.channels.set(profileA.accounts.app.id, channelA);
    sdkMock.channels.set(profileB.accounts.app.id, channelB);

    const sup = new Supervisor({ configPath, rootDir: root, runPreflight: false });
    supervisors.push(sup);

    await withProcessEnv(
      {
        APP_SECRET: 'pin-secret',
        [envBinVar(kindA)]: fakeA.path,
        [envBinVar(kindB)]: fakeB.path,
      },
      async () => {
        await sup.startProfile(kindA);
        await sup.startProfile(kindB);
        expect(sup.isOnline(kindA)).toBe(true);
        expect(sup.isOnline(kindB)).toBe(true);
        expect(sup.list().map((row) => row.agentKind).sort()).toEqual([kindA, kindB].sort());

        await channelA.handlers.message?.(
          mentionMessage({
            messageId: `om_${kindA}_to_${kindB}`,
            content: `${PIN_PROMPT} @${pinnedDisplayName(kindB)}`,
            mentionedOpenId: `ou_${kindB}`,
            mentionedName: pinnedDisplayName(kindB),
          }),
        );
        await waitForQuietCalls(channelA);

        expect(await readScriptedRecords(fakeA.recordPath)).toHaveLength(1);
        expect(await readScriptedRecords(fakeB.recordPath)).toHaveLength(0);
        expect(channelB.calls.filter((call) => call.op === 'send' || call.op === 'stream')).toHaveLength(0);

        const registry = JSON.parse(await readFile(join(root, 'registry', 'processes.json'), 'utf8')) as {
          entries: Array<{ profileName: string; agentKind: string; appId: string }>;
        };
        expect(registry.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              profileName: kindA,
              agentKind: kindA,
              appId: profileA.accounts.app.id,
            }),
            expect.objectContaining({
              profileName: kindB,
              agentKind: kindB,
              appId: profileB.accounts.app.id,
            }),
          ]),
        );

        const catalogPathA = join(root, 'profiles', kindA, 'sessions.json.catalog.json');
        const catalogPathB = join(root, 'profiles', kindB, 'sessions.json.catalog.json');
        const handleA = scriptedCatalogHandle(kindA);
        await waitUntil(async () =>
          asCatalogEntries(await readCatalog(catalogPathA)).some((row) =>
            isActiveHandle(row, kindA, handleA),
          ),
        );
        const catalogA = asCatalogEntries(await readCatalog(catalogPathA));
        const catalogB = asCatalogEntries(await readCatalog(catalogPathB));
        expect(catalogB).toEqual([]);
        const entryA = catalogA.find((row) => isActiveHandle(row, kindA, handleA));
        expect(entryA).toMatchObject({ agentId: kindA, status: 'active' });
        switch (handleA.field) {
          case 'sessionId':
            expect(entryA?.sessionId).toBe(handleA.sessionId);
            expect(entryA?.threadId).toBeUndefined();
            break;
          case 'threadId':
            expect(entryA?.threadId).toBe(handleA.threadId);
            expect(entryA?.sessionId).toBeUndefined();
            break;
          default: {
            const exhaustive: never = handleA;
            throw new Error(`unhandled catalog handle: ${String(exhaustive)}`);
          }
        }

        const lockA = JSON.parse(
          await readFile(join(root, 'registry', 'locks', 'profile', `${kindA}.lock.meta.json`), 'utf8'),
        ) as { profile: string; agentKind: string };
        const lockB = JSON.parse(
          await readFile(join(root, 'registry', 'locks', 'profile', `${kindB}.lock.meta.json`), 'utf8'),
        ) as { profile: string; agentKind: string };
        expect(lockA).toMatchObject({ profile: kindA, agentKind: kindA });
        expect(lockB).toMatchObject({ profile: kindB, agentKind: kindB });
      },
    );
  });
});

function profileFor(kind: 'kimi' | 'grok' | 'cursor', appId: string, workspace: string) {
  const profile = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: appId, secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  profile.workspaces.default = workspace;
  return profile;
}

async function readCatalog(path: string): Promise<unknown[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function asCatalogEntries(raw: unknown[]): SessionCatalogEntry[] {
  return raw.filter((row): row is SessionCatalogEntry => {
    if (typeof row !== 'object' || row === null) return false;
    const entry = row as Partial<SessionCatalogEntry>;
    return typeof entry.agentId === 'string' && typeof entry.status === 'string';
  });
}

function isActiveHandle(
  row: SessionCatalogEntry,
  kind: string,
  handle: ScriptedCatalogHandle,
): boolean {
  if (row.agentId !== kind || row.status !== 'active') return false;
  switch (handle.field) {
    case 'sessionId':
      return row.sessionId === handle.sessionId && row.threadId === undefined;
    case 'threadId':
      return row.threadId === handle.threadId && row.sessionId === undefined;
    default: {
      const exhaustive: never = handle;
      throw new Error(`unhandled catalog handle: ${String(exhaustive)}`);
    }
  }
}

function mentionMessage(input: {
  messageId: string;
  content: string;
  mentionedOpenId: string;
  mentionedName: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_dm_a',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    mentions: [{ openId: input.mentionedOpenId, name: input.mentionedName, isBot: true, key: input.mentionedOpenId }],
    createTime: 1_700_000_001_000,
  } as unknown as NormalizedMessage;
}
