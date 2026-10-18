import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';
import { listRecentSessions } from '../../src/session/history.js';

// Opt-in: inherits the existing Claude Code login, provider and config, and
// spends model quota. Omit MODEL to exercise the user's configured default.
// CLAUDE_REAL_SMOKE=1 CLAUDE_REAL_SMOKE_MODEL=<account-supported-model> \
//   pnpm exec vitest run tests/process/claude-real.smoke.test.ts
const RUN = process.env.CLAUDE_REAL_SMOKE === '1';
const binary = process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude';
const model = process.env.CLAUDE_REAL_SMOKE_MODEL;
const dirs: string[] = [];
const activeRuns = new Set<AgentRun>();

afterEach(async () => {
  const results = await Promise.allSettled([...activeRuns].map(async run => {
    await run.stop();
    if (!await run.waitForExit(1000)) throw new Error('Claude smoke child did not exit during cleanup');
    activeRuns.delete(run);
  }));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Claude smoke cleanup failed');
}, 30_000);

afterAll(async () => {
  if (activeRuns.size) throw new Error('Keeping smoke workspaces because Claude cleanup failed');
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('ClaudeAdapter real binary smoke', () => {
  it('resumes context, writes and verifies a file, and lists native history', async () => {
    const { cwd, adapter } = await fixture();
    const token = `CLAUDE-SMOKE-${randomUUID()}`;
    const first = await collect(adapter.run({ runId: 'claude-first', cwd, model,
      prompt: `Remember the token ${token}. Reply only with that token. Do not use tools or contact services.`,
    }));
    expectNormal(first);
    expect(text(first)).toContain(token);
    const handle = first.find(event => event.type === 'system')?.resumeHandle;
    expect(handle).toBeTruthy();
    const resumed = await collect(adapter.run({ runId: 'claude-file', cwd, model, resumeHandle: handle,
      prompt: 'Write compat.txt in this directory containing exactly CLAUDE-FILE-COMPAT followed by one newline, then read it to verify. Reply FILE-CREATED and the exact token from the previous turn. Operate only in this workspace. Do not contact external services or send messages.',
    }));
    expectNormal(resumed);
    expect(text(resumed)).toContain(token);
    expect(text(resumed)).toContain('FILE-CREATED');
    expect(resumed.find(event => event.type === 'system')?.resumeHandle).toBe(handle);
    expect(resumed.some(event => event.type === 'tool_use')).toBe(true);
    expect(resumed.some(event => event.type === 'tool_result' && !event.isError)).toBe(true);
    expect(await readFile(join(cwd, 'compat.txt'), 'utf8')).toBe('CLAUDE-FILE-COMPAT\n');
    expect((await listRecentSessions(cwd, 10)).some(entry => entry.sessionId === handle)).toBe(true);
  }, 300_000);

  // Confirms CLI exit and context recovery, not termination of independent
  // processes that a tool may have created. The tool's sleep is bounded.
  it('interrupts during a tool call and resumes after confirmed CLI exit', async () => {
    const { cwd, adapter } = await fixture();
    const run = adapter.run({ runId: 'claude-stop', cwd, model, stopGraceMs: 1000,
      prompt: 'Use a shell tool to sleep for 20 seconds (sleep 20 on POSIX, Start-Sleep -Seconds 20 on Windows). Do not answer before the command finishes. Do not contact services or run other tools.',
    });
    let stopped = false;
    const events = await collect(run, async event => {
      if (event.type === 'tool_use' && !stopped && /sleep/i.test(JSON.stringify(event.input))) {
        stopped = true;
        await run.stop();
      }
    });
    expect(stopped).toBe(true);
    expect(await run.waitForExit(1000)).toBe(true);
    const handle = events.find(event => event.type === 'system')?.resumeHandle;
    expect(handle).toBeTruthy();
    expect(events.filter(event => event.type === 'done' || event.type === 'error')).toEqual([
      { type: 'done', resumeHandle: handle, terminationReason: 'interrupted' },
    ]);
    const resumed = await collect(adapter.run({ runId: 'claude-after-stop', cwd, model, resumeHandle: handle,
      prompt: 'The previous task was intentionally stopped. Do not repeat it. Reply exactly CLAUDE-RESUMED-AFTER-STOP without tools.',
    }));
    expectNormal(resumed);
    expect(text(resumed)).toContain('CLAUDE-RESUMED-AFTER-STOP');
    expect(resumed.find(event => event.type === 'system')?.resumeHandle).toBe(handle);
  }, 300_000);
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'claude real 中文 '));
  dirs.push(cwd);
  const adapter = new ClaudeAdapter({ binary });
  expect((await adapter.checkAvailability()).ok).toBe(true);
  return { cwd, adapter };
}

async function collect(run: AgentRun, onEvent?: (event: AgentEvent) => Promise<void>) {
  activeRuns.add(run);
  const events: AgentEvent[] = [];
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void run.stop().catch(() => {}); }, 90_000);
  try {
    for await (const event of run.events) { events.push(event); await onEvent?.(event); }
    if (timedOut) throw new Error(`Claude real smoke turn timed out: ${run.stderrSnapshot ?? ''}`);
    return events;
  } finally {
    clearTimeout(timer);
    if (!await run.waitForExit(10_000)) await run.stop();
    if (!await run.waitForExit(1000)) throw new Error('Claude smoke child exit was not confirmed');
    activeRuns.delete(run);
  }
}

function expectNormal(events: AgentEvent[]) {
  expect(events.filter(event => event.type === 'done' || event.type === 'error')).toEqual([
    expect.objectContaining({ type: 'done', terminationReason: 'normal' }),
  ]);
}
function text(events: AgentEvent[]) {
  return events.map(event => event.type === 'text' ? event.delta : event.type === 'final_text' ? event.content : '').join('');
}
