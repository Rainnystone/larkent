import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { answerInMeeting, meetingScopeId } from '../../../src/meeting/orchestrator';
import { MeetingSession } from '../../../src/meeting/session';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { writeScriptedJsonlExecutable } from '../../helpers/fake-executable';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { waitForPidFile } from '../../helpers/wait-for-file';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('meeting idle budget through a silent CLI subprocess', () => {
  it('terminates without controls.cfg at the default 15-minute idle budget', async () => {
    const h = await harness();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(h.handle.stopRequest).toBeUndefined();
    expect(() => process.kill(h.pid, 0)).not.toThrow();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.handle.stopRequest).toEqual({ type: 'bridge-idle-watchdog' });
    expect(await h.answer()).toBe('_15 分钟无响应,已自动终止_');
    expect(await h.handle.run.waitForExit(0)).toBe(true);
    expect(h.activeRuns.get(h.scope)).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors the configured two-minute budget instead of the default', async () => {
    const h = await harness(2);
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(h.handle.stopRequest).toBeUndefined();
    expect(() => process.kill(h.pid, 0)).not.toThrow();

    await vi.advanceTimersByTimeAsync(1);
    expect(await h.answer()).toBe('_2 分钟无响应,已自动终止_');
    expect(await h.handle.run.waitForExit(0)).toBe(true);
    expect(h.activeRuns.get(h.scope)).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an explicitly disabled idle budget', async () => {
    const h = await harness(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.handle.stopRequest).toBeUndefined();
    expect(() => process.kill(h.pid, 0)).not.toThrow();

    await h.activeRuns.stopAll({ type: 'meeting' });
    expect(await h.answer()).toBe('');
    expect(h.pool.snapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function harness(idleMinutes?: number) {
  const tmp = await createTmpProfile('meeting-idle-budget-');
  cleanups.push(tmp.cleanup);
  const readyPath = join(tmp.root, 'ready');
  const binary = await writeScriptedJsonlExecutable(tmp.root, 'silent-cli', {
    lines: [], hang: true, readyPath,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'grok',
    accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
  });
  profileConfig.workspaces.default = tmp.workspace;
  profileConfig.meeting.enabled = true;
  const controls: Controls = {
    profile: 'meeting-idle-test', profileConfig, cfg: {
      accounts: profileConfig.accounts,
      preferences: { runIdleTimeoutMinutes: idleMinutes },
    },
    ownerRefreshState: 'unknown',
    async refreshOwner() {}, async restart() {}, async exit() {},
    configPath: join(tmp.root, 'config.json'), processId: 'meeting-idle-test',
  };
  // Exercise the runtime omission despite Controls requiring cfg in TypeScript.
  if (idleMinutes === undefined) Reflect.deleteProperty(controls, 'cfg');
  const session = new MeetingSession({
    client: { request: async () => ({ code: 0, data: {} }) as never },
    meetingId: 'synthetic-meeting', meetingNo: '123456789',
    config: profileConfig.meeting, joinedWithAccessCheck: true,
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const executor = new RunExecutor({
    agent: new GrokAdapter({ binary: binary.path, stopGraceMs: 500 }), activeRuns, pool,
  });
  // Only the business clock is virtual; subprocesses, pipes and file IO are real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const answering = answerInMeeting({
    session, controls, executor, activeRuns, sessions, workspaces,
    channel: createRecordingLarkChannel() as unknown as LarkChannel,
  }, 'Synthetic meeting question', { deliver: 'caller', admitted: true });
  cleanups.push(async () => {
    await activeRuns.stopAll({ type: 'meeting' });
    await answering;
    await Promise.all([sessions.flush(), workspaces.flush()]);
  });
  const pid = await waitForPidFile(readyPath, AbortSignal.timeout(10_000));
  const scope = meetingScopeId(session.meetingId);
  const handle = activeRuns.get(scope)!;
  expect(handle.run.pid).toBe(pid);
  return {
    activeRuns, pool, handle, pid, scope,
    async answer() {
      const deadline = new AbortController();
      try {
        return await Promise.race([
          answering,
          delay(5000, undefined, { ref: false, signal: deadline.signal }).then(() => {
            throw new Error('meeting did not settle after idle timeout');
          }),
        ]);
      } finally { deadline.abort(); }
    },
  };
}
