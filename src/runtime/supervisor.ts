import pkg from '../../package.json';
import { startChannel as realStartChannel, type BridgeChannel } from '../bot/channel';
import type { Controls } from '../commands';
import type { AppPaths } from '../config/app-paths';
import { isComplete, type AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import { refreshOwnerControls } from '../policy/owner';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { preFlightChecks } from '../cli/preflight';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
} from './agent-runtime';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import { resolveProfileRuntime } from './profile-runtime';
import {
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from './registry';

type StartChannelFn = typeof realStartChannel;

export interface SupervisorOptions {
  /** Root config path (config.json). */
  configPath: string;
  /** LARK_CHANNEL_HOME root; undefined = default. */
  rootDir?: string;
  /** Injectable for tests (defaults to the real startChannel). */
  startChannelFn?: StartChannelFn;
  /** Run lark-cli preflight per profile (default true; tests pass false). */
  runPreflight?: boolean;
}

export interface ManagedStatus {
  profile: string;
  agentKind: AgentKind;
  online: boolean;
  pid: number;
  startedAt?: string;
  botName?: string;
  appId?: string;
}

/**
 * One profile's live bridge inside the supervisor. Owns its locks, registry
 * entry, stores, channel and `controls`. `stop()` tears down ONLY this profile
 * (no process.exit) so the supervisor keeps hosting the others.
 */
class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  private restartOperation: Promise<void> | undefined;
  private stopOperation: Promise<void> | undefined;
  private stopped = false;
  private shutdownFailure: { error: unknown } | undefined;
  private readonly pendingDisconnects = new Set<BridgeChannel>();

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private agent: AgentAdapter,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private onExitCommand: (profile: string) => Promise<void>,
  ) {}

  get appId(): string {
    return this.cfg.accounts.app.id;
  }

  get botName(): string | undefined {
    return this.bridge?.channel.botIdentity?.name;
  }

  get online(): boolean {
    return this.bridge !== undefined;
  }

  async bringUp(nowIso: string): Promise<void> {
    this.startedAt = nowIso;
    // The supervisor owns this profile before bringUp starts. Every acquired
    // resource joins the same stop/rollback path, including a second-lock failure.
    this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.profileConfig.agentKind));
    this.locks.push(
      await acquireAppRuntimeLock(this.appPaths, this.appId, this.profileConfig.agentKind),
    );
    this.entry = await register({
      appId: this.appId,
      tenant: this.cfg.accounts.app.tenant,
      profileName: this.appPaths.profile,
      agentKind: this.profileConfig.agentKind,
      configPath: this.configPath,
      version: pkg.version,
      registryFile: this.appPaths.userRegistryFile,
    });
    this.controls = this.makeControls(this.appPaths, this.cfg, this.profileConfig);
    this.bridge = await this.startChannelFn({
      cfg: this.cfg,
      agent: this.agent,
      sessions: this.sessions,
      sessionCatalog: this.sessionCatalog,
      workspaces: this.workspaces,
      controls: this.controls,
      appPaths: this.appPaths,
    });
    const botName = this.bridge.channel.botIdentity?.name;
    if (botName) {
      await updateEntry(this.entry.id, { botName }, this.appPaths.userRegistryFile).catch((err) =>
        log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
      );
    }
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    if (this.stopped) return Promise.resolve();
    // Claim stop before running any asynchronous teardown. Concurrent callers
    // share this result, and no later reconnect may create an unowned bridge.
    this.stopOperation = Promise.resolve().then(() => this.stopOwned()).finally(() => {
      this.stopOperation = undefined;
    });
    return this.stopOperation;
  }

  private async stopOwned(): Promise<void> {
    // An earlier reconnect owns both bridges until transfer or rollback ends.
    // Its caller receives its failure; stop then handles every retained owner.
    if (this.restartOperation) await this.restartOperation.catch(() => {});
    const bridges = this.bridge ? [this.bridge, ...this.pendingDisconnects] : [...this.pendingDisconnects];
    const results = await Promise.allSettled(bridges.map(async bridge => {
      await bridge.disconnect();
      this.pendingDisconnects.delete(bridge);
    }));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) {
      const error = failures.length === 1 ? failures[0] : new AggregateError(failures, 'profile bridges did not stop');
      this.shutdownFailure = { error };
      log.warn('supervisor', 'disconnect-failed', { profile: this.profile, err: String(error) });
      throw error;
    }
    if (this.entry) {
      try {
        await unregister(this.entry.id, this.appPaths.userRegistryFile);
      } catch (error) {
        this.shutdownFailure = { error };
        log.warn('supervisor', 'unregister-failed', { profile: this.profile, err: String(error) });
        throw error;
      }
    }
    const locks = this.locks;
    const released = await Promise.allSettled(locks.map(async lock => { await lock.release(); }));
    this.locks = locks.filter((_lock, index) => released[index]?.status === 'rejected');
    const lockFailures = released.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [];
      log.warn('supervisor', 'lock-release-failed', {
        profile: this.profile, kind: locks[index]?.kind, target: locks[index]?.target, err: String(result.reason),
      });
      return [result.reason];
    });
    if (lockFailures.length) {
      const error = lockFailures.length === 1 ? lockFailures[0] : new AggregateError(lockFailures, 'profile locks did not release');
      this.shutdownFailure = { error };
      throw error;
    }
    this.shutdownFailure = undefined;
    this.stopped = true;
  }

  /** Best-effort sync unregister for the process 'exit' hook. */
  unregisterSelfSync(): void {
    if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
  }

  status(pid: number): ManagedStatus {
    return {
      profile: this.profile,
      agentKind: this.profileConfig.agentKind,
      online: this.online,
      pid,
      startedAt: this.startedAt,
      botName: this.botName,
      appId: this.appId,
    };
  }

  private makeControls(
    currentPaths: AppPaths,
    currentCfg: AppConfig,
    currentProfileConfig: ProfileConfig,
  ): Controls {
    const self = this;
    const currentControls: Controls = {
      profile: currentPaths.profile,
      profileConfig: currentProfileConfig,
      ownerRefreshState: 'unknown',
      knownChats: [],
      async refreshOwner(channelOverride) {
        const target = channelOverride ?? self.bridge?.channel;
        if (!target) return;
        await refreshOwnerControls(currentControls, target, currentControls.cfg.accounts.app.id);
      },
      configPath: self.configPath,
      cfg: currentCfg,
      processId: self.entry.id,
      async exit() {
        // `/exit` from chat stops THIS profile's channel; the supervisor lives on.
        await self.onExitCommand(self.profile);
      },
      async restart() {
        await self.restart();
      },
    };
    return currentControls;
  }

  /** Connect-before-disconnect reconnect for this profile (e.g. after /account). */
  private restart(): Promise<void> {
    if (this.stopOperation) return Promise.reject(new Error(`profile ${this.profile} is stopping`));
    if (this.stopped) return Promise.reject(new Error(`profile ${this.profile} is stopped`));
    if (this.shutdownFailure) return Promise.reject(this.shutdownFailure.error);
    if (this.restartOperation) return this.restartOperation;
    this.restartOperation = Promise.resolve().then(() => this.reconnect()).finally(() => {
      this.restartOperation = undefined;
    });
    return this.restartOperation;
  }

  private async reconnect(): Promise<void> {
    let nextAppLock: AcquiredRuntimeLock | undefined;
    try {
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      assertReconnectAgentKindUnchanged(this.profileConfig.agentKind, nextRuntime.profileConfig.agentKind);
      const nextAgent = createRuntimeAgent(nextRuntime.profileConfig, {
        ...nextRuntime.appPaths,
        configPath: nextRuntime.configPath,
      });
      const availability = await checkRuntimeAgentAvailability(nextAgent);
      if (!availability.ok) throw availability.error;

      const appChanged = next.accounts.app.id !== this.cfg.accounts.app.id;
      if (appChanged) {
        nextAppLock = await acquireAppRuntimeLock(
          nextRuntime.appPaths,
          next.accounts.app.id,
          nextRuntime.profileConfig.agentKind,
        );
        this.locks.push(nextAppLock);
      }
      const nextControls = this.makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
      const nextBridge = await this.startChannelFn({
        cfg: next,
        agent: nextAgent,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: nextControls,
        appPaths: nextRuntime.appPaths,
      });
      try {
        await this.bridge.disconnect();
      } catch (err) {
        log.warn('supervisor', 'old-disconnect-failed', { profile: this.profile, err: String(err) });
        const failures = [err];
        try {
          await nextBridge.disconnect();
        } catch (rollbackError) {
          log.warn('supervisor', 'rollback-disconnect-failed', { profile: this.profile, err: String(rollbackError) });
          failures.push(rollbackError);
          // Keep every failed bridge and its app lock owned for a later stop.
          this.pendingDisconnects.add(nextBridge);
          if (nextAppLock) {
            nextAppLock = undefined;
          }
        }
        const error = failures.length === 1 ? err : new AggregateError(failures, 'profile reconnect rollback failed');
        this.shutdownFailure = { error };
        throw error;
      }
      this.bridge = nextBridge;
      await updateEntry(
        this.entry.id,
        {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath: this.configPath,
          botName: nextBridge.channel.botIdentity?.name,
        },
        this.appPaths.userRegistryFile,
      ).catch((err) => log.warn('registry', 'update-failed', { err: String(err) }));
      const oldAppLock = nextAppLock
        ? this.locks.find(lock => lock.kind === 'app' && lock !== nextAppLock)
        : undefined;
      // Publish the connected bridge's configuration before releasing its
      // predecessor's lock. A release failure must not describe the new bridge
      // as the old app, or lose either lock's ownership.
      nextAppLock = undefined;
      this.cfg = next;
      this.profileConfig = nextRuntime.profileConfig;
      this.agent = nextAgent;
      this.controls = nextControls;
      if (oldAppLock) await this.releaseOwnedLock(oldAppLock);
    } catch (error) {
      if (nextAppLock) {
        try {
          await this.releaseOwnedLock(nextAppLock);
        } catch (releaseError) {
          const failure = new AggregateError([error, releaseError], 'profile reconnect cleanup failed');
          this.shutdownFailure = { error: failure };
          throw failure;
        }
      }
      throw error;
    }
  }

  private async releaseOwnedLock(lock: AcquiredRuntimeLock): Promise<void> {
    try {
      await lock.release();
    } catch (error) {
      this.shutdownFailure = { error };
      log.warn('supervisor', 'lock-release-failed', {
        profile: this.profile, kind: lock.kind, target: lock.target, err: String(error),
      });
      throw error;
    }
    this.locks = this.locks.filter(owned => owned !== lock);
  }
}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private managed = new Map<string, ManagedProfile>();
  private readonly starting = new Map<string, Promise<void>>();
  private closing = false;
  private shutdownOperation: Promise<void> | undefined;

  constructor(private opts: SupervisorOptions) {}

  private get startChannelFn(): StartChannelFn {
    return this.opts.startChannelFn ?? realStartChannel;
  }

  isOnline(profile: string): boolean {
    return this.managed.get(profile)?.online ?? false;
  }

  controlsFor(profile: string): Controls | undefined {
    return this.managed.get(profile)?.controls;
  }

  channelFor(profile: string) {
    return this.managed.get(profile)?.bridge?.channel;
  }

  list(): ManagedStatus[] {
    return [...this.managed.values()].map((m) => m.status(process.pid));
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  startProfile(profile: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('supervisor is shutting down'));
    const starting = this.starting.get(profile);
    if (starting) return starting;
    const owned = this.managed.get(profile);
    if (owned) return owned.online ? Promise.resolve() : Promise.reject(
      new Error(`profile ${profile} has incomplete startup cleanup; stop it before retrying`),
    );
    // Claim admission synchronously so duplicate start, stop and shutdown all
    // join this operation, including its preflight and partial-start rollback.
    const operation = Promise.resolve().then(() => this.startOwnedProfile(profile)).finally(() => {
      this.starting.delete(profile);
    });
    this.starting.set(profile, operation);
    return operation;
  }

  private async startOwnedProfile(profile: string): Promise<void> {
    const runtime = await resolveProfileRuntime({
      config: this.opts.configPath,
      profile,
      allowBootstrap: false,
    });
    const { cfg, appPaths, profileConfig, configPath } = runtime;
    if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);

    // Dedupe by app id — two channels for one app fight over event routing.
    for (const m of this.managed.values()) {
      if (m.appId === cfg.accounts.app.id) {
        throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
      }
    }

    if (this.opts.runPreflight !== false) {
      await preFlightChecks({
        bridgeConfig: cfg,
        profileConfig,
        appPaths,
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
      });
    }

    const agent = createRuntimeAgent(profileConfig, { ...appPaths, configPath });
    if (this.opts.runPreflight !== false) {
      const availability = await checkRuntimeAgentAvailability(agent);
      if (!availability.ok) throw availability.error;
    }

    const sessions = new SessionStore(appPaths.sessionsFile);
    await sessions.load();
    const sessionCatalog = new SessionCatalog(`${appPaths.sessionsFile}.catalog.json`);
    await sessionCatalog.load();
    const workspaces = new WorkspaceStore(appPaths.workspacesFile);
    await workspaces.load();

    const managed = new ManagedProfile(
      appPaths.profile,
      appPaths,
      configPath,
      cfg,
      profileConfig,
      agent,
      sessions,
      sessionCatalog,
      workspaces,
      this.startChannelFn,
      (p) => this.stopProfile(p),
    );
    this.managed.set(appPaths.profile, managed);
    try {
      await managed.bringUp(new Date().toISOString());
    } catch (error) {
      try {
        await managed.stop();
        this.managed.delete(appPaths.profile);
      } catch (cleanupError) {
        // A failed rollback remains in managed for a later stop/shutdown retry.
        throw new AggregateError([error, cleanupError], 'profile startup rollback failed');
      }
      throw error;
    }
    if (!this.closing) {
      log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
    }
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    // The start caller owns its error; stop owns cleanup of anything retained.
    const starting = this.starting.get(profile);
    if (starting) await starting.catch(() => {});
    const managed = this.managed.get(profile);
    if (!managed) return;
    await managed.stop();
    if (this.managed.get(profile) === managed) this.managed.delete(profile);
    log.info('supervisor', 'profile-offline', { profile });
  }

  async restartProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed?.online) throw new Error(`profile 未在运行：${profile}`);
    await managed.controls.restart();
  }

  /** Stop every profile — for process shutdown. */
  shutdown(): Promise<void> {
    this.closing = true;
    this.shutdownOperation ??= Promise.resolve().then(() => this.shutdownOwned()).finally(() => {
      this.shutdownOperation = undefined;
    });
    return this.shutdownOperation;
  }

  private async shutdownOwned(): Promise<void> {
    // Admission is closed. Startup callers observe their own errors; shutdown
    // waits for rollback and then retries all resources that remain owned.
    await Promise.allSettled(this.starting.values());
    const failures: unknown[] = [];
    // Profiles share one registry file. Finish each stop's registry write
    // before the next one, while preserving every failure for the caller.
    for (const profile of [...this.managed.keys()]) {
      try {
        await this.stopProfile(profile);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'supervisor shutdown did not complete cleanly');
  }

  /** Sync best-effort unregister of all entries (for the process 'exit' hook). */
  unregisterAllSync(): void {
    for (const m of this.managed.values()) m.unregisterSelfSync();
  }
}
