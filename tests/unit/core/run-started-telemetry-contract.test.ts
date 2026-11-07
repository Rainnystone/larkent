import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  closeLogger,
  configureLogger,
  flushLogger,
  withTrace,
} from '../../../src/core/logger.js';
import { loadTelemetryAdapter } from '../../../src/core/telemetry.js';
import type { RunPolicyAllow } from '../../../src/policy/run-policy.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { last6, specTaskKey } from '../../helpers/spec-task-key.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const PROFILE = 'claude';
const CHAT_ID = 'oc_abcdefghijklmnopqrstuvwxyz123456';
const MESSAGE_ID = 'om_source_message_abcdef789012';
const SCOPE_ID = 'oc_abcdefghijklmnopqrstuvwxyz123456:omt_topic_zzzzzz';
const RUN_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TASK_KEY = specTaskKey(PROFILE, CHAT_ID, MESSAGE_ID);

const cleanups: Array<() => Promise<void>> = [];

type CapturedEvent = {
  phase: string;
  event: string;
  ts: string;
  fields: Record<string, unknown>;
  ctx: Record<string, unknown>;
};

function capturedEvents(): CapturedEvent[] {
  const g = globalThis as typeof globalThis & { __runStartedTelemetry?: CapturedEvent[] };
  return g.__runStartedTelemetry ?? [];
}

async function installCapturingAdapter(tmp: TmpProfile): Promise<void> {
  const adapterPath = join(tmp.root, 'run-started-capture.mjs');
  await writeFile(
    adapterPath,
    `
      globalThis.__runStartedTelemetry ??= [];
      export default function createAdapter() {
        return {
          emit(event) { globalThis.__runStartedTelemetry.push(event); },
          recordError() {},
          recordMetric() {},
        };
      }
    `,
  );
  process.env.LARK_CHANNEL_TELEMETRY_MODULE = pathToFileURL(adapterPath).href;
  await loadTelemetryAdapter({ version: 'test', appId: 'cli_test_app', tenant: 'feishu' });
}

function policy(cwd: string): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'do not put this prompt in telemetry',
    requestedCwd: cwd,
    cwdRealpath: cwd,
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2_000_000_000_000,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function submitStarted(opts: {
  tmp: TmpProfile;
  runId: string;
  taskKey?: string;
}): Promise<void> {
  const executor = new RunExecutor({
    agent: new FakeAgentAdapter({
      events: [[{ type: 'done', terminationReason: 'normal' }]],
    }),
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => opts.runId,
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 1,
  });
  const execution = await withTrace({ chatId: CHAT_ID, msgId: MESSAGE_ID }, async () =>
    executor.submit({
      scopeId: SCOPE_ID,
      policy: policy(opts.tmp.workspace),
      observability: {
        profile: PROFILE,
        agent: 'claude',
        source: 'im',
        stage: 'submit',
        ...(opts.taskKey ? { taskKey: opts.taskKey } : {}),
      },
    }),
  );
  await collect(execution.subscribe());
}

describe('run/started telemetry contract', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    delete process.env.LARK_CHANNEL_TELEMETRY_MODULE;
    const g = globalThis as typeof globalThis & { __runStartedTelemetry?: CapturedEvent[] };
    delete g.__runStartedTelemetry;
    await closeLogger();
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('delivers untruncated taskKey and runId after sanitization', async () => {
    const tmp = await createTmpProfile('run-started-contract-');
    cleanups.push(tmp.cleanup);
    configureLogger({
      logsDir: join(tmp.profile, 'logs'),
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });
    await installCapturingAdapter(tmp);

    await submitStarted({ tmp, runId: RUN_A, taskKey: TASK_KEY });
    await flushLogger();

    const started = capturedEvents().find((event) => event.phase === 'run' && event.event === 'started');
    expect(started).toBeDefined();
    expect(started?.fields.taskKey).toBe(TASK_KEY);
    expect(started?.fields.taskKey).toMatch(/^[0-9a-f]{32}$/);
    expect(started?.fields.runId).toBe(RUN_A);
    expect(started?.fields.agent).toBe('claude');
    expect(started?.fields.scope).toBe(last6(SCOPE_ID));
    expect(typeof started?.ts).toBe('string');
    expect(started?.ts.length).toBeGreaterThan(0);
    expect(started?.ctx.chatId).toBe(last6(CHAT_ID));
    expect(started?.ctx.msgId).toBe(last6(MESSAGE_ID));

    const serialized = JSON.stringify(started);
    expect(serialized).not.toContain(CHAT_ID);
    expect(serialized).not.toContain(MESSAGE_ID);
    expect(serialized).not.toContain('do not put this prompt in telemetry');
    expect(String(started?.fields.taskKey)).not.toMatch(/^\.{3}/);
    expect(String(started?.fields.runId)).not.toMatch(/^\.{3}/);
  });

  it('keeps the same taskKey when the same message is retried with a new runId', async () => {
    const tmp = await createTmpProfile('run-started-retry-');
    cleanups.push(tmp.cleanup);
    configureLogger({
      logsDir: join(tmp.profile, 'logs'),
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });
    await installCapturingAdapter(tmp);

    await submitStarted({ tmp, runId: RUN_A, taskKey: TASK_KEY });
    await submitStarted({ tmp, runId: RUN_B, taskKey: TASK_KEY });

    const started = capturedEvents().filter((event) => event.phase === 'run' && event.event === 'started');
    expect(started).toHaveLength(2);
    expect(started[0]?.fields.taskKey).toBe(TASK_KEY);
    expect(started[1]?.fields.taskKey).toBe(TASK_KEY);
    expect(started[0]?.fields.runId).toBe(RUN_A);
    expect(started[1]?.fields.runId).toBe(RUN_B);
  });

  it('keeps the same taskKey after a simulated restart with a fresh executor', async () => {
    const first = await createTmpProfile('run-started-restart-a-');
    cleanups.push(first.cleanup);
    configureLogger({
      logsDir: join(first.profile, 'logs'),
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });
    await installCapturingAdapter(first);
    await submitStarted({ tmp: first, runId: RUN_A, taskKey: TASK_KEY });

    const second = await createTmpProfile('run-started-restart-b-');
    cleanups.push(second.cleanup);
    configureLogger({
      logsDir: join(second.profile, 'logs'),
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });
    await installCapturingAdapter(second);
    await submitStarted({ tmp: second, runId: RUN_B, taskKey: TASK_KEY });

    const started = capturedEvents().filter((event) => event.phase === 'run' && event.event === 'started');
    expect(started.map((event) => event.fields.taskKey)).toEqual([TASK_KEY, TASK_KEY]);
    expect(started.map((event) => event.fields.runId)).toEqual([RUN_A, RUN_B]);
  });

  it('omits taskKey for non-message runs so the plugin can fall back to run_id', async () => {
    const tmp = await createTmpProfile('run-started-no-task-');
    cleanups.push(tmp.cleanup);
    configureLogger({
      logsDir: join(tmp.profile, 'logs'),
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });
    await installCapturingAdapter(tmp);

    await submitStarted({ tmp, runId: RUN_A });

    const started = capturedEvents().find((event) => event.phase === 'run' && event.event === 'started');
    expect(started?.fields.runId).toBe(RUN_A);
    expect(started?.fields.taskKey).toBeUndefined();
  });
});
