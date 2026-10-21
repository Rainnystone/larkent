import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';

const mocks = vi.hoisted(() => ({ startRunFlow: vi.fn() }));
vi.mock('../../../src/bot/run-flow', () => ({ startRunFlow: mocks.startRunFlow }));

const { answerInMeeting } = await import('../../../src/meeting/orchestrator');
const { MeetingSession } = await import('../../../src/meeting/session');
const { MEETING_DEFAULTS, createDefaultProfileConfig } = await import(
  '../../../src/config/profile-schema'
);

const noopClient = { request: vi.fn(async () => ({ code: 0, data: {} }) as never) };

function session() {
  return new MeetingSession({
    client: noopClient,
    meetingId: '70001',
    meetingNo: '123456789',
    topic: '周会',
    config: { ...MEETING_DEFAULTS, enabled: true },
    joinedWithAccessCheck: true,
  });
}

function deps(idleMinutes: number) {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  profileConfig.meeting = { ...MEETING_DEFAULTS, enabled: true };
  return {
    session: session(),
    channel: { send: vi.fn(async () => ({} as never)) },
    controls: {
      profile: 'claude',
      profileConfig,
      cfg: { preferences: { runIdleTimeoutMinutes: idleMinutes } },
    },
    executor: {},
    activeRuns: { interrupt: vi.fn() },
    sessions: {},
    workspaces: {},
  } as never;
}

function hang(stop: () => void, first?: { type: 'text'; delta: string }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run: AgentRun = {
    runId: 'meeting-run',
    events: (async function* () {})(),
    stop: async () => { release(); },
    waitForExit: async () => true,
  };
  const handle: RunHandle = { run, interrupted: false, lastEventAt: 0 };
  const wrapped = {
    ...run,
    stop: async () => {
      stop();
      release();
    },
  };
  handle.run = wrapped;
  return {
    ok: true as const,
    execution: {
      handle,
      run: wrapped,
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          if (first) yield first;
          await gate;
        },
      }),
    },
    policy: {},
    cwdRealpath: '/tmp/repo',
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('meeting idle watchdog', () => {
  it('stops a hung run after the idle budget and returns a timeout notice', async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    mocks.startRunFlow.mockResolvedValue(hang(stopped));
    const pending = answerInMeeting(deps(1), '还在吗', { deliver: 'caller', admitted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const answer = await pending;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(answer).toContain('1 分钟无响应,已自动终止');
  });

  it('keeps a partial answer and still appends the timeout notice', async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    mocks.startRunFlow.mockResolvedValue(hang(stopped, { type: 'text', delta: '先说一半' }));
    const pending = answerInMeeting(deps(1), '还在吗', { deliver: 'caller', admitted: true });
    await vi.advanceTimersByTimeAsync(60_000);
    const answer = await pending;
    expect(stopped).toHaveBeenCalled();
    expect(answer).toContain('先说一半');
    expect(answer).toContain('分钟无响应,已自动终止');
  });
});
