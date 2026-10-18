import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';
import { listCodexThreadHistory } from '../../src/session/codex-history.js';

// Opt-in: uses the existing Codex login/config and spends model quota.
// CODEX_REAL_SMOKE=1 CODEX_REAL_SMOKE_MODEL=<account-supported-model> \
//   pnpm exec vitest run tests/process/codex-real.smoke.test.ts
// Omit CODEX_REAL_SMOKE_MODEL to exercise the user's configured CLI default.
const RUN = process.env.CODEX_REAL_SMOKE === '1';
const binary = process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
const model = process.env.CODEX_REAL_SMOKE_MODEL;
const dirs: string[] = [];
const activeRuns = new Set<AgentRun>();

// Synthetic 64x64 solid RGB PNGs; the resumed turn changes color so a model
// cannot pass the image assertion by remembering the first picture.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC';

// Vitest's outer timeout does not cancel an executing test promise. The
// hook owns any run whose collect() has not reached its finally block yet.
afterEach(async () => {
  const results = await Promise.allSettled([...activeRuns].map(async run => {
    await run.stop();
    if (!await run.waitForExit(1000)) throw new Error('Codex smoke child did not exit during cleanup');
    activeRuns.delete(run);
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map(result => result.reason), 'Codex smoke cleanup failed');
  }
}, 30_000);

afterAll(async () => {
  if (activeRuns.size > 0) throw new Error('Keeping smoke workspaces because Codex cleanup failed');
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('CodexAdapter real binary smoke', () => {
  it('handles images, resumes the same thread, writes a file, and lists native history', async () => {
    const { dir, profileStateDir, adapter } = await createSmoke();
    const token = `CODEX-SMOKE-${randomUUID()}`;
    const red = join(dir, 'red image.png');
    const blue = join(dir, 'blue image.png');
    await writeFile(red, Buffer.from(RED_PNG, 'base64'));
    await writeFile(blue, Buffer.from(BLUE_PNG, 'base64'));

    const first = await collect(adapter.run({
      runId: 'codex-smoke-first', cwd: dir, model, images: [red],
      prompt: `Remember the token ${token}. Look at the attached image. Reply with the token and its dominant color in English. Do not use tools.`,
    }));
    expectNormal(first);
    expect(finalText(first)).toContain(token);
    expect(finalText(first)).toMatch(/red/i);
    const handle = first.find(event => event.type === 'system')?.resumeHandle;
    expect(handle).toBeTruthy();

    const resumed = await collect(adapter.run({
      runId: 'codex-smoke-resume', cwd: dir, model, resumeHandle: handle, images: [blue],
      prompt: 'What exact token did I ask you to remember? Also identify the dominant color of this newly attached image in English. Reply with just the token and color. Do not use tools.',
    }));
    expectNormal(resumed);
    expect(finalText(resumed)).toContain(token);
    expect(finalText(resumed)).toMatch(/blue/i);
    expect(resumed.find(event => event.type === 'system')?.resumeHandle).toBe(handle);

    const file = await collect(adapter.run({
      runId: 'codex-smoke-file', cwd: dir, model, resumeHandle: handle,
      prompt: 'Use a shell command to create compat.txt in this workspace containing exactly CODEX-FILE-COMPAT followed by a newline. Then reply FILE-CREATED. Do not access external services or files outside this workspace.',
    }));
    expectNormal(file);
    expect(finalText(file)).toContain('FILE-CREATED');
    expect(file.some(event => event.type === 'tool_use')).toBe(true);
    expect(file.some(event => event.type === 'tool_result' && !event.isError)).toBe(true);
    expect(await readFile(join(dir, 'compat.txt'), 'utf8')).toBe('CODEX-FILE-COMPAT\n');

    const history = await listCodexThreadHistory({ binary, cwd: dir, limit: 10, profileStateDir });
    expect(history.some(entry => entry.threadId === handle)).toBe(true);
  }, 420_000); // Three 90s turns plus process cleanup and history query.

  it('stops an active tool, confirms exit, and can resume the interrupted thread', async () => {
    const { dir, adapter } = await createSmoke();
    const run = adapter.run({
      runId: 'codex-smoke-stop', cwd: dir, model,
      prompt: 'Run one shell command that sleeps for 20 seconds (use sleep 20 on POSIX, Start-Sleep -Seconds 20 on Windows) and then prints CODEX-STOP-DONE. Do not answer before that command finishes.',
    });
    let stoppedDuringTool = false;
    const stopped = await collect(run, async event => {
      if (event.type === 'tool_use' && !stoppedDuringTool && /sleep/i.test(JSON.stringify(event.input))) {
        stoppedDuringTool = true;
        await run.stop();
      }
    });
    expect(stoppedDuringTool).toBe(true);
    expect(await run.waitForExit(1000)).toBe(true);
    expect(run.exit !== undefined || run.signal !== undefined).toBe(true);
    expect(stopped.filter(event => event.type === 'done' || event.type === 'error')).toEqual([
      expect.objectContaining({ type: 'done', terminationReason: 'interrupted' }),
    ]);

    const handle = stopped.find(event => event.type === 'system')?.resumeHandle;
    expect(handle).toBeTruthy();
    const resumed = await collect(adapter.run({
      runId: 'codex-smoke-after-stop', cwd: dir, model, resumeHandle: handle,
      prompt: 'The previous task was intentionally stopped. Do not repeat its command. Reply with exactly CODEX-RESUMED-AFTER-STOP without using tools.',
    }));
    expectNormal(resumed);
    expect(finalText(resumed)).toContain('CODEX-RESUMED-AFTER-STOP');
    expect(resumed.find(event => event.type === 'system')?.resumeHandle).toBe(handle);
  }, 300_000); // Two 90s turns plus process cleanup.
});

async function createSmoke() {
  // Spaces exercise argv boundaries for cwd, images and profile state.
  const dir = await mkdtemp(join(tmpdir(), 'codex real '));
  dirs.push(dir);
  const profileStateDir = join(dir, 'profile state');
  await mkdir(profileStateDir);
  const adapter = new CodexAdapter({ binary, profileStateDir, sandbox: 'workspace-write' });
  expect((await adapter.checkAvailability()).ok).toBe(true);
  return { dir, profileStateDir, adapter };
}

async function collect(run: AgentRun, onEvent?: (event: AgentEvent) => Promise<void>): Promise<AgentEvent[]> {
  activeRuns.add(run);
  const events: AgentEvent[] = [];
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void run.stop().catch(() => {}); }, 90_000);
  try {
    for await (const event of run.events) {
      events.push(event);
      await onEvent?.(event);
    }
    if (timedOut) throw new Error(`Codex real smoke turn timed out: ${run.stderrSnapshot ?? ''}`);
    return events;
  } finally {
    clearTimeout(deadline);
    if (!await run.waitForExit(10_000)) await run.stop();
    activeRuns.delete(run);
  }
}

function expectNormal(events: AgentEvent[]): void {
  expect(events.filter(event => event.type === 'done' || event.type === 'error')).toEqual([
    expect.objectContaining({ type: 'done', terminationReason: 'normal' }),
  ]);
}

function finalText(events: AgentEvent[]): string {
  return events.filter(event => event.type === 'final_text').map(event => event.content).join('');
}
