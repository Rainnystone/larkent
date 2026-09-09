import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun } from '../../../src/agent/types';
import type { Controls } from '../../../src/commands';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { parkWithShutdown } from '../../../src/cli/commands/start';
import { acquireHostLock } from '../../../src/runtime/host-lock';
import { checkRuntimeLock } from '../../../src/runtime/locks';
import * as runtimeLocks from '../../../src/runtime/locks';
import { readAndPrune } from '../../../src/runtime/registry';
import * as registry from '../../../src/runtime/registry';
import { Supervisor } from '../../../src/runtime/supervisor';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel, type RecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface';
import { ProcessPool } from '../../../src/bot/process-pool';
import { commentTokenDigest } from '../../../src/bot/comment-resource';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const sdk = vi.hoisted(() => ({ channel: undefined as RecordingLarkChannel | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel!,
}));
import { startChannel, type BridgeChannel } from '../../../src/bot/channel';

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
async function channelHarness(agent: AgentAdapter, reply: 'card' | 'text' = 'text', maxConcurrentRuns = 3) {
  const root = await temp();
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const profile = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] }, preferences: { messageReply: reply, cotMessages: 'off', maxConcurrentRuns },
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
  return { bridge, sessions, catalog, workspaces, paths, root, channel: sdk.channel! };
}
async function send(channel: RecordingLarkChannel, chatId = 'oc_test') {
  await channel.handlers.message?.({
    messageId: `om_${chatId}`, chatId, chatType: 'group', senderId: 'ou_user',
    content: 'hello', rawContentType: 'text', resources: [], mentionedBot: true, createTime: 1760000001000,
  });
}

describe('settled profile persistence', () => {
  it('waits for the bot consumer after run cleanup and saves the last system event before resolving', async () => {
    const producerReady = deferred();
    const renderingBlocked = deferred();
    const renderRelease = deferred();
    let updates = 0;
    sdk.channel!.stream = async (_chatId, input) => {
      const card = input as { card: { producer(ctrl: { update(value: unknown): Promise<void> }): Promise<void> } };
      await card.card.producer({ async update() {
        updates++;
        if (updates === 1) producerReady.resolve();
        else { renderingBlocked.resolve(); await renderRelease.promise; }
      } });
    };
    const run = controlledAgent({ beforeSecond: producerReady.promise });
    const h = await channelHarness(run.agent, 'card');
    const sequence: string[] = [];
    const originalFlush = h.sessions.flush.bind(h.sessions);
    vi.spyOn(h.sessions, 'flush').mockImplementation(async () => { sequence.push('flush'); await originalFlush(); });
    await send(h.channel);
    await renderingBlocked.promise;
    let done = false;
    const closing = h.bridge.disconnect().then(() => { done = true; });
    try {
      await run.stopRequested.promise;
      await run.finalBuffered.promise;
      run.cleanup.resolve();
      // Let child settlement finish while the existing bot renderer is held.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(done).toBe(false);
      expect(sequence).toEqual([]);
    } finally {
      run.cleanup.resolve();
      renderRelease.resolve();
      await closing;
    }
    const reopenedSessions = new SessionStore(h.paths.sessionsFile);
    const reopenedCatalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
    await Promise.all([reopenedSessions.load(), reopenedCatalog.load()]);
    expect(reopenedSessions.resumeFor('oc_test', h.root)).toBe('final-on-stop');
    expect(reopenedCatalog.entries()).toEqual([expect.objectContaining({ scopeId: 'oc_test', agentId: 'claude', cwdRealpath: h.root, resumeHandle: 'final-on-stop' })]);
    expect(sequence).toEqual(['flush']);
  });

  it.each(['final handle', 'consumer settlement'])('drains interrupted comments through %s before flushing', async check => {
    const run = controlledAgent();
    const reactionCleanup = deferred();
    const releaseReaction = deferred();
    const rawClient = {
      wiki: { v2: { space: { async getNode() { throw { response: { data: { code: 131005 } } }; } } } },
      drive: { v1: { fileComment: {
        async get() { return { data: { is_whole: true, reply_list: { replies: [{ reply_id: 'reply-1', content: { elements: [{ type: 'text_run', text_run: { text: 'question' } }] } }] } } }; },
        async list() { return { data: { items: [] } }; },
      } } },
      async request(input: { data?: { action?: string } }) {
        if (input.data?.action === 'delete') { reactionCleanup.resolve(); await releaseReaction.promise; }
        return { code: 0 };
      },
    };
    Object.assign(sdk.channel!, { comments: makeFakeCommentSurface(rawClient) });
    const h = await channelHarness(run.agent);
    const handling = h.channel.handlers.comment?.({ fileToken: 'doc-token', fileType: 'docx', commentId: 'comment-1', replyId: 'reply-1', mentionedBot: true, operator: { openId: 'ou_user' } });
    await run.started.promise;
    let done = false;
    const closing = h.bridge.disconnect().then(() => { done = true; });
    try {
      await run.finalBuffered.promise;
      run.cleanup.resolve();
      await reactionCleanup.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (check === 'consumer settlement') expect(done).toBe(false);
    } finally {
      run.cleanup.resolve();
      releaseReaction.resolve();
      await Promise.all([closing, handling]);
    }
    const restored = new SessionStore(h.paths.sessionsFile);
    const catalog = new SessionCatalog(`${h.paths.sessionsFile}.catalog.json`);
    await Promise.all([restored.load(), catalog.load()]);
    const scope = `doc:${commentTokenDigest('doc-token')}`;
    expect(restored.resumeFor(scope, h.root)).toBe('final-on-stop');
    expect(catalog.entries()[0]?.resumeHandle).toBe('final-on-stop');
    expect(h.channel.sent).toEqual([]);
  });

  it('saves system handles delivered after interruption even without a rendering delay', async () => {
    const run = controlledAgent();
    const h = await channelHarness(run.agent);
    await send(h.channel);
    await run.started.promise;
    const closing = h.bridge.disconnect();
    await run.finalBuffered.promise;
    run.cleanup.resolve();
    await closing;
    const restored = new SessionStore(h.paths.sessionsFile);
    await restored.load();
    expect(restored.resumeFor('oc_test', h.root)).toBe('final-on-stop');
  });

  it('settles queued consumers even when the active run cannot release its pool slot', async () => {
    const queued = deferred();
    let pool: ProcessPool | undefined;
    const acquire = ProcessPool.prototype.acquire;
    vi.spyOn(ProcessPool.prototype, 'acquire').mockImplementation(function (this: ProcessPool) {
      pool = this;
      const result = acquire.call(this);
      if (this.snapshot().waiting === 1) queued.resolve();
      return result;
    });
    const run = controlledAgent({ cleanupError: new Error('active child remains owned') });
    const spawn = vi.spyOn(run.agent, 'run');
    const h = await channelHarness(run.agent, 'text', 1);
    // This test owns closing: the RED must diagnose the blocked promise without
    // asking afterEach to await that same known-stuck shutdown indefinitely.
    cleanups.pop();
    await send(h.channel);
    await run.started.promise;
    await send(h.channel, 'oc_queued');
    await queued.promise;
    let outcome: unknown;
    const closing = h.bridge.disconnect().then(() => { outcome = 'success'; }, error => { outcome = error; });
    try {
      await run.finalBuffered.promise;
      run.cleanup.resolve();
      await vi.waitFor(() => expect(outcome).toBeInstanceOf(AggregateError));
      await closing;
      const restored = new SessionStore(h.paths.sessionsFile);
      await restored.load();
      expect(restored.resumeFor('oc_test', h.root)).toBe('final-on-stop');
      expect(restored.getRaw('oc_queued')).toBeUndefined();
      expect(pool?.snapshot()).toMatchObject({ active: 1, waiting: 0 });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { run.cleanup.resolve(); }
  });

  it('attempts disconnect and every store flush and rejects all persistence failures', async () => {
    const h = await channelHarness({ id: 'claude', displayName: 'fake', isAvailable: async () => true, run: () => { throw new Error('no run expected'); } });
    const failures = [new Error('sessions save failed'), new Error('catalog save failed'), new Error('nonce save failed'), new Error('workspaces save failed')];
    const attempted: string[] = [];
    vi.spyOn(h.channel, 'disconnect').mockImplementation(async () => { attempted.push('channel'); });
    vi.spyOn(h.sessions, 'flush').mockImplementation(async () => { attempted.push('sessions'); throw failures[0]; });
    vi.spyOn(h.catalog, 'flush').mockImplementation(async () => { attempted.push('catalog'); throw failures[1]; });
    vi.spyOn(CallbackNonceStore.prototype, 'flush').mockImplementation(async () => { attempted.push('nonce'); throw failures[2]; });
    vi.spyOn(h.workspaces, 'flush').mockImplementation(async () => { attempted.push('workspaces'); throw failures[3]; });
    await expect(h.bridge.disconnect()).rejects.toMatchObject({ errors: failures });
    expect(attempted).toEqual(['channel', 'sessions', 'catalog', 'nonce', 'workspaces']);
  });

  it('reports failed run cleanup while still persisting its final handle and attempting channel disconnect', async () => {
    const failure = new Error('child cleanup failed');
    const run = controlledAgent({ cleanupError: failure });
    const h = await channelHarness(run.agent);
    const disconnect = vi.spyOn(h.channel, 'disconnect');
    await send(h.channel);
    await run.started.promise;
    const closing = h.bridge.disconnect();
    const outcome = closing.then(() => undefined, error => error);
    await run.finalBuffered.promise;
    run.cleanup.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(disconnect).toHaveBeenCalled();
    const restored = new SessionStore(h.paths.sessionsFile);
    await restored.load();
    expect(restored.resumeFor('oc_test', h.root)).toBe('final-on-stop');
  });
});

async function supervisorHarness() {
  const root = await temp();
  const paths = resolveAppPaths({ rootDir: root, profile: 'a' });
  const binary = await writeVersionExecutable(root, 'claude', 'claude 0.0.0-test');
  const config = createRootConfig('a', createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'cli_a', secret: '${APP_SECRET}', tenant: 'feishu' } },
  }));
  config.profiles.b = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_b', secret: '${APP_SECRET}', tenant: 'feishu' } } });
  for (const profile of Object.values(config.profiles)) { profile.workspaces.default = root; profile.agent.binaryPath = binary; }
  await saveRootConfig(config, paths.configFile);
  const bridges: Array<{ profile: string; bridge: BridgeChannel; fail?: Error; attempts: number }> = [];
  const sup = new Supervisor({ configPath: paths.configFile, runPreflight: false, startChannelFn: async deps => {
    const channel = createRecordingLarkChannel();
    const item = { profile: deps.controls.profile, bridge: undefined as unknown as BridgeChannel, fail: undefined as Error | undefined, attempts: 0 };
    item.bridge = { channel: channel as unknown as BridgeChannel['channel'], disconnect: async () => { item.attempts++; if (item.fail) throw item.fail; } };
    bridges.push(item);
    return item.bridge;
  } });
  cleanups.push(async () => { for (const item of bridges) item.fail = undefined; await sup.shutdown(); });
  return { sup, bridges, paths };
}

describe('shutdown callers preserve failed ownership', () => {
  it.each(['profile', 'app'] as const)('reports a failed %s lock release, attempts the other lock and retries without starting a bridge', async kind => {
    const failure = new Error(`${kind} lock release failed`);
    const acquired: runtimeLocks.AcquiredRuntimeLock[] = [];
    for (const method of ['acquireProfileRuntimeLock', 'acquireAppRuntimeLock'] as const) {
      // Retain real file-backed locks and inject failure only at their release.
      const original = runtimeLocks[method];
      vi.spyOn(runtimeLocks, method).mockImplementation(async (...args: unknown[]) => {
        const lock = await Reflect.apply(original, runtimeLocks, args);
        const release = lock.release.bind(lock);
        vi.spyOn(lock, 'release').mockImplementationOnce(async () => {
          if (lock.kind === kind) throw failure;
          await release();
        });
        acquired.push(lock);
        return lock;
      });
    }
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    await expect(h.sup.stopProfile('a')).rejects.toBe(failure);
    expect(acquired).toHaveLength(2);
    for (const lock of acquired) {
      expect(lock.release).toHaveBeenCalledTimes(1);
      expect((await checkRuntimeLock(lock.target)).locked).toBe(lock.kind === kind);
    }
    expect(h.sup.isOnline('a')).toBe(true);
    await expect(h.sup.restartProfile('a')).rejects.toBe(failure);
    expect(h.bridges).toHaveLength(1);
    await h.sup.stopProfile('a');
    expect(h.sup.isOnline('a')).toBe(false);
    for (const lock of acquired) expect((await checkRuntimeLock(lock.target)).locked).toBe(false);
  });

  it('keeps a registry persistence failure visible and refuses a new bridge until stop succeeds', async () => {
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    const failure = new Error('registry removal save failed');
    vi.spyOn(registry, 'unregister').mockRejectedValueOnce(failure);
    await expect(h.sup.stopProfile('a')).rejects.toBe(failure);
    expect(readAndPrune(h.paths.userRegistryFile).map(entry => entry.profileName)).toEqual(['a']);
    expect((await checkRuntimeLock(h.paths.profileLockFile)).locked).toBe(true);
    await expect(h.sup.restartProfile('a')).rejects.toBe(failure);
    expect(h.bridges).toHaveLength(1);
    await h.sup.stopProfile('a');
    expect(h.sup.isOnline('a')).toBe(false);
  });

  it.each(['stopProfile', 'exit'] as const)('propagates %s rejection and retains profile locks and registry', async caller => {
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    const failure = new Error('save failed after settlement');
    h.bridges[0]!.fail = failure;
    const stopping = caller === 'exit' ? h.sup.controlsFor('a')!.exit() : h.sup.stopProfile('a');
    await expect(stopping).rejects.toBe(failure);
    expect(h.sup.isOnline('a')).toBe(true);
    expect(readAndPrune(h.paths.userRegistryFile).map(entry => entry.profileName)).toEqual(['a']);
    expect((await checkRuntimeLock(h.paths.profileLockFile)).locked).toBe(true);
    expect((await checkRuntimeLock(h.paths.appLockFile('cli_a'))).locked).toBe(true);
    h.bridges[0]!.fail = undefined;
    await h.sup.stopProfile('a');
    expect(h.sup.isOnline('a')).toBe(false);
  });

  it('attempts every profile on shutdown, removes only successful profiles and propagates errors', async () => {
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    await h.sup.startProfile('b');
    h.bridges[0]!.fail = new Error('profile a cleanup failed');
    await expect(h.sup.shutdown()).rejects.toMatchObject({ errors: [h.bridges[0]!.fail] });
    expect(h.bridges.map(item => item.attempts)).toEqual([1, 1]);
    expect(h.sup.list().map(item => item.profile)).toEqual(['a']);
    expect(readAndPrune(h.paths.userRegistryFile).map(entry => entry.profileName)).toEqual(['a']);
  });

  it.each([false, true])('rolls back reconnect and retains every failed bridge when new cleanup fails=%s', async failNext => {
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    h.bridges[0]!.fail = new Error('old bridge did not settle');
    const config = (await loadRootConfig(h.paths.configFile))!;
    config.profiles.a!.accounts.app.id = 'cli_changed';
    await saveRootConfig(config, h.paths.configFile);
    // Set the rollback failure as soon as the second bridge exists, before old disconnect rejects.
    const oldDisconnect = h.bridges[0]!.bridge.disconnect;
    h.bridges[0]!.bridge.disconnect = async () => {
      if (failNext && h.bridges[1]) h.bridges[1].fail = new Error('new bridge did not settle');
      await oldDisconnect();
    };
    await expect(h.sup.restartProfile('a')).rejects.toBeDefined();
    expect(h.sup.channelFor('a')).toBe(h.bridges[0]!.bridge.channel);
    expect(h.bridges.map(item => item.attempts)).toEqual([1, 1]);
    expect(readAndPrune(h.paths.userRegistryFile)[0]?.appId).toBe('cli_a');
    expect((await checkRuntimeLock(h.paths.appLockFile('cli_a'))).locked).toBe(true);
    expect((await checkRuntimeLock(h.paths.appLockFile('cli_changed'))).locked).toBe(failNext);
    await expect(h.sup.restartProfile('a')).rejects.toBeDefined();
    expect(h.bridges).toHaveLength(2);
    h.bridges[0]!.bridge.disconnect = oldDisconnect;
    for (const item of h.bridges) item.fail = undefined;
    await h.sup.stopProfile('a');
    expect((await checkRuntimeLock(h.paths.appLockFile('cli_changed'))).locked).toBe(false);
    expect(h.bridges[1]!.attempts).toBe(failNext ? 2 : 1);
  });
});

describe('foreground and daemon signal owner', () => {
  it.each(['registry', 'retry'] as const)('preserves failed shutdown %s and keeps the host lock until success', async check => {
    const h = await supervisorHarness();
    await h.sup.startProfile('a');
    const hostLock = (await acquireHostLock(h.paths.hostLockFile))!;
    cleanups.push(async () => { await hostLock.release().catch(() => {}); });
    const hooks = new Map<string, () => void>();
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      hooks.set(String(event), listener);
      return process;
    });
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation(code => { exits.push(code); return undefined as never; });
    const previousExitCode = process.exitCode;
    h.bridges[0]!.fail = new Error('signal cleanup failed');
    try {
      void parkWithShutdown(h.sup, h.paths, undefined, hostLock);
      hooks.get('SIGTERM')!();
      await vi.waitFor(() => expect(h.bridges[0]!.attempts).toBe(1));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(exits).toEqual([]);
      expect((await checkRuntimeLock(h.paths.hostLockFile)).locked).toBe(true);
      expect(h.sup.isOnline('a')).toBe(true);
      if (check === 'registry') {
        hooks.get('exit')!();
        expect(readAndPrune(h.paths.userRegistryFile).map(entry => entry.profileName)).toEqual(['a']);
        expect(process.exitCode).toBe(1);
      } else {
        h.bridges[0]!.fail = undefined;
        hooks.get('SIGINT')!();
        await vi.waitFor(() => expect(exits).toEqual([0]));
        expect(h.bridges).toHaveLength(1);
        expect(h.sup.isOnline('a')).toBe(false);
        expect((await checkRuntimeLock(h.paths.hostLockFile)).locked).toBe(false);
        expect(readAndPrune(h.paths.userRegistryFile)).toEqual([]);
      }
    } finally { process.exitCode = previousExitCode; }
  });
});
