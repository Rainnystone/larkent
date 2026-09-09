import type { LarkChannel } from '@larksuite/channel';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import type { Controls } from '../../../src/commands';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { RunExecutor, type RunExecution } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { ResumeCandidates } from '../../../src/session/resume-candidates';
import type { SessionCatalogIdentity } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel, type RecordingLarkChannel } from '../../helpers/recording-lark-channel';

const sdk = vi.hoisted(() => ({ channel: undefined as RecordingLarkChannel | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel!,
}));
import { startChannel } from '../../../src/bot/channel';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { sdk.channel = createRecordingLarkChannel(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shutdown-persistence-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function controlledAgent(options: { beforeSecond?: Promise<void>; cleanupError?: Error } = {}) {
  const started = deferred();
  const stopRequested = deferred();
  const finalBuffered = deferred();
  const cleanup = deferred();
  let exited = false;
  const agent: AgentAdapter = {
    id: 'claude', displayName: 'Controlled Claude', isAvailable: async () => true,
    run(opts): AgentRun {
      started.resolve();
      return {
        runId: opts.runId,
        events: { async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          if (options.beforeSecond) await options.beforeSecond;
          yield { type: 'text', delta: 'second' };
          await stopRequested.promise;
          yield { type: 'system', resumeHandle: 'final-on-stop' };
          finalBuffered.resolve();
          await cleanup.promise;
        } },
        async stop() {
          stopRequested.resolve();
          await cleanup.promise;
          if (options.cleanupError) throw options.cleanupError;
          exited = true;
        },
        async waitForExit() { await cleanup.promise; return exited; },
      };
    },
  };
  return { agent, started, stopRequested, finalBuffered, cleanup };
}
async function channelHarness(agent: AgentAdapter, reply: 'card' | 'text' = 'text', maxConcurrentRuns = 3, agentKind: 'claude' | 'kimi' = 'claude') {
  const root = await temp();
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const profile = createDefaultProfileConfig({
    agentKind, accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], admins: ['ou_user'] }, preferences: { messageReply: reply, cotMessages: 'off', maxConcurrentRuns },
  });
  profile.workspaces.default = root;
  const sessions = new SessionStore(paths.sessionsFile);
  const catalog = new SessionCatalog(`${paths.sessionsFile}.catalog.json`);
  const workspaces = new WorkspaceStore(paths.workspacesFile);
  await Promise.all([sessions.load(), catalog.load(), workspaces.load()]);
  const controls: Controls = {
    profile: 'test', profileConfig: profile, cfg: profile, configPath: paths.configFile,
    processId: 'test', exit: async () => {}, restart: async () => {},
    ownerRefreshState: 'unknown', refreshOwner: async () => {},
  };
  const bridge = await startChannel({ cfg: profile, agent, sessions, sessionCatalog: catalog, workspaces, controls, appPaths: paths });
  cleanups.push(async () => { await bridge.disconnect().catch(() => {}); });
  return { bridge, sessions, catalog, workspaces, paths, root, profile, controls, channel: sdk.channel! };
}
async function send(channel: RecordingLarkChannel, chatId = 'oc_test') {
  await channel.handlers.message?.({
    messageId: `om_${chatId}`, chatId, chatType: 'group', senderId: 'ou_user',
    content: 'hello', rawContentType: 'text', resources: [], mentionedBot: true, createTime: 1760000001000,
  });
}


// Late events must respect a command acknowledged while the old run is stopping.
it.each(['/new', '/reset', '/cd', '/ws use saved'])('does not resurrect a session after %s acknowledged clearing it', async command => {
  const output = deferred();
  const run = controlledAgent({ beforeSecond: output.promise });
  const h = await channelHarness(run.agent);
  h.workspaces.saveNamed('saved', h.root);
  h.sessions.set('oc_test', 'original', h.root);
  await send(h.channel);
  await run.started.promise;
  try {
    await h.channel.handlers.message?.({
      messageId: 'om_new', chatId: 'oc_test', chatType: 'group', senderId: 'ou_user',
      content: command === '/cd' ? `/cd ${h.root}` : command, rawContentType: 'text', resources: [], mentionedBot: true,
    });
    await run.stopRequested.promise;
    expect(h.sessions.resumeFor('oc_test', h.root)).toBeUndefined();
    output.resolve();
    await run.finalBuffered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    output.resolve();
    run.cleanup.resolve();
    await h.bridge.disconnect();
  }
  const restored = new SessionStore(h.paths.sessionsFile);
  const catalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
  await Promise.all([restored.load(), catalog.load()]);
  expect(restored.resumeFor('oc_test', h.root)).toBeUndefined();
  expect(catalog.entries().filter(entry => entry.status === 'active')).toEqual([]);
  await expectNextRun(h, undefined);
});

it('keeps a selected resume handle after the old stopped run drains', async () => {
  const output = deferred();
  const run = controlledAgent({ beforeSecond: output.promise });
  const h = await channelHarness({ ...run.agent, id: 'kimi', displayName: 'Controlled Kimi' }, 'text', 3, 'kimi');
  vi.spyOn(h.channel as unknown as LarkChannel, 'getChatMode').mockResolvedValue('p2p');
  let selection: { nonce: string; identity: SessionCatalogIdentity } | undefined;
  const originalIssue = ResumeCandidates.prototype.issue;
  vi.spyOn(ResumeCandidates.prototype, 'issue').mockImplementation(function (this: ResumeCandidates, identity, handle) {
    const nonce = originalIssue.call(this, identity, handle);
    selection = { nonce, identity };
    return nonce;
  });
  h.sessions.set('oc_test', 'chosen-history-handle', h.root);
  const command = {
    messageId: 'om_resume', chatId: 'oc_test', chatType: 'p2p', senderId: 'ou_user',
    content: '/resume', rawContentType: 'text', resources: [], mentionedBot: true,
  };
  await h.channel.handlers.message?.(command);
  expect(selection).toBeDefined();
  await send(h.channel);
  await run.started.promise;
  try {
    await h.channel.handlers.message?.({ ...command, messageId: 'om_apply', content: `/resume use ${selection!.nonce}` });
    await run.stopRequested.promise;
    expect(h.catalog.activeFor(selection!.identity)?.resumeHandle).toBe('chosen-history-handle');
    output.resolve();
    await run.finalBuffered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    output.resolve();
    run.cleanup.resolve();
    await h.bridge.disconnect();
  }
  const catalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
  await catalog.load();
  expect(catalog.activeFor(selection!.identity)?.resumeHandle).toBe('chosen-history-handle');
  await expectNextRun(h, 'chosen-history-handle');
});


async function expectNextRun(h: Awaited<ReturnType<typeof channelHarness>>, resumeHandle: string | undefined) {
  const sessions = new SessionStore(h.paths.sessionsFile);
  const catalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
  const workspaces = new WorkspaceStore(h.paths.workspacesFile);
  await Promise.all([sessions.load(), catalog.load(), workspaces.load()]);
  const agent = new FakeAgentAdapter({ id: h.profile.agentKind, events: [{ type: 'done', terminationReason: 'normal' }] });
  sdk.channel = createRecordingLarkChannel();
  const bridge = await startChannel({ cfg: h.profile, agent, sessions, sessionCatalog: catalog, workspaces, controls: h.controls, appPaths: h.paths });
  try {
    await send(sdk.channel);
    await vi.waitFor(() => expect(agent.runOptions).toHaveLength(1));
    expect(agent.runOptions[0]?.resumeHandle).toBe(resumeHandle);
    expect(agent.runOptions[0]?.cwd).toBe(h.root);
  } finally {
    await bridge.disconnect();
  }
}

// Pause the actual card consumer while the executor completes all raw events.
// Commands must invalidate that consumer even though no active process remains.
it.each(['/new', '/reset', '/cd', '/resume use'])('preserves %s after finished while the old renderer is paused', async command => {
  const output = deferred();
  const firstUpdate = deferred();
  const rendererPaused = deferred();
  const rendererRelease = deferred();
  const releaseExit = deferred();
  const runOptions: AgentRunOptions[] = [];
  let execution: RunExecution | undefined;
  let activeRuns: ActiveRuns | undefined;
  const originalSubmit = RunExecutor.prototype.submit;
  vi.spyOn(RunExecutor.prototype, 'submit').mockImplementation(async function (this: RunExecutor, input) {
    const result = await originalSubmit.call(this, input);
    execution = result;
    return result;
  });
  const originalRegister = ActiveRuns.prototype.register;
  vi.spyOn(ActiveRuns.prototype, 'register').mockImplementation(function (this: ActiveRuns, ...args) {
    activeRuns = this;
    return originalRegister.apply(this, args);
  });
  const agent: AgentAdapter = {
    id: 'kimi', displayName: 'Controlled Kimi', isAvailable: async () => true,
    run(opts) {
      runOptions.push(opts);
      return {
        runId: opts.runId,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          await output.promise;
          yield { type: 'text', delta: 'second' };
          yield { type: 'system', resumeHandle: 'late-old-handle' };
          yield { type: 'done', terminationReason: 'normal' };
        })(),
        stop: async () => { releaseExit.resolve(); },
        waitForExit: async () => { await releaseExit.promise; return true; },
      };
    },
  };
  const h = await channelHarness(agent, 'card', 3, 'kimi');
  let selection: { nonce: string; identity: SessionCatalogIdentity } | undefined;
  const originalIssue = ResumeCandidates.prototype.issue;
  vi.spyOn(ResumeCandidates.prototype, 'issue').mockImplementation(function (this: ResumeCandidates, identity, handle) {
    const nonce = originalIssue.call(this, identity, handle);
    selection = { nonce, identity };
    return nonce;
  });
  h.sessions.set('oc_test', 'chosen-history-handle', h.root);
  if (command === '/resume use') {
    vi.spyOn(h.channel as unknown as LarkChannel, 'getChatMode').mockResolvedValue('p2p');
    await sendCommand(h.channel, '/resume');
    expect(selection).toBeDefined();
  }
  vi.spyOn(h.channel, 'stream').mockImplementation(async (_chat, input) => {
    const card = input as { card: { producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> } };
    await card.card.producer({ update: async value => {
      firstUpdate.resolve();
      if (JSON.stringify(value).includes('second')) {
        rendererPaused.resolve();
        await rendererRelease.promise;
      }
    } });
  });
  try {
    await send(h.channel);
    await firstUpdate.promise;
    output.resolve();
    await rendererPaused.promise;
    releaseExit.resolve();
    await execution!.finished;
    expect(activeRuns!.get('oc_test')).toBeUndefined();
    expect(h.sessions.resumeFor('oc_test', h.root)).toBe('chosen-history-handle');
    const text = command === '/resume use' ? `/resume use ${selection!.nonce}` : command === '/cd' ? `/cd ${h.root}` : command;
    await sendCommand(h.channel, text);
  } finally {
    output.resolve();
    rendererRelease.resolve();
    releaseExit.resolve();
    await h.bridge.disconnect();
  }
  expect(runOptions).toHaveLength(1);
  const selected = command === '/resume use' ? 'chosen-history-handle' : undefined;
  const restored = new SessionStore(h.paths.sessionsFile);
  const catalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
  await Promise.all([restored.load(), catalog.load()]);
  expect(restored.resumeFor('oc_test', h.root)).toBe(selected);
  expect(catalog.entries().filter(entry => entry.status === 'active').map(entry => entry.resumeHandle)).toEqual(selected ? [selected] : []);
  await expectNextRun(h, selected);
});

async function sendCommand(channel: RecordingLarkChannel, content: string) {
  await channel.handlers.message?.({
    messageId: `command-${content}`, chatId: 'oc_test', chatType: 'group', senderId: 'ou_user',
    content, rawContentType: 'text', resources: [], mentionedBot: true,
  });
}

it.each(['/stop', '/cd relative-path', '/resume use invalid-nonce'])('keeps the final handle after %s without an accepted new session decision', async command => {
  const output = deferred();
  const run = controlledAgent({ beforeSecond: output.promise });
  const h = await channelHarness({ ...run.agent, id: 'kimi' }, 'text', 3, 'kimi');
  await send(h.channel);
  await run.started.promise;
  try {
    await sendCommand(h.channel, command);
    // Shutdown is the stop requester for rejected commands.
    const disconnecting = h.bridge.disconnect();
    await run.stopRequested.promise;
    output.resolve();
    await run.finalBuffered.promise;
    run.cleanup.resolve();
    await disconnecting;
  } finally {
    output.resolve();
    run.cleanup.resolve();
    await h.bridge.disconnect();
  }
  const restored = new SessionStore(h.paths.sessionsFile);
  await restored.load();
  expect(restored.resumeFor('oc_test', h.root)).toBe('final-on-stop');
  await expectNextRun(h, 'final-on-stop');
});


it('releases the old consumer writer before a queued next run saves its own handle', async () => {
  const output = deferred();
  const run = controlledAgent({ beforeSecond: output.promise });
  const options: AgentRunOptions[] = [];
  const h = await channelHarness({ ...run.agent, run: opts => {
    options.push(opts);
    return run.agent.run(opts);
  } });
  h.sessions.set('oc_test', 'original', h.root);
  try {
    await send(h.channel);
    await run.started.promise;
    await sendCommand(h.channel, '/new');
    await send(h.channel);
    expect(options).toHaveLength(1);
    output.resolve();
    await run.finalBuffered.promise;
    run.cleanup.resolve();
    await vi.waitFor(() => expect(options).toHaveLength(2));
    expect(options[1]?.resumeHandle).toBeUndefined();
    await vi.waitFor(() => expect(h.sessions.resumeFor('oc_test', h.root)).toBe('final-on-stop'));
  } finally {
    output.resolve();
    run.cleanup.resolve();
    await h.bridge.disconnect();
  }
  const restored = new SessionStore(h.paths.sessionsFile);
  await restored.load();
  expect(restored.resumeFor('oc_test', h.root)).toBe('final-on-stop');
});
