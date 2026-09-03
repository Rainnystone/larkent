import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

// Smoke test against the real `kimi` binary. Skipped unless explicitly
// enabled: it spends model quota and requires a logged-in kimi CLI.
//   KIMI_REAL_SMOKE=1 npx vitest run tests/process/kimi-real.smoke.test.ts
const RUN = process.env.KIMI_REAL_SMOKE === '1';
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('KimiAdapter real binary smoke', () => {
  it('runs a prompt and resumes the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-real-'));
    dirs.push(dir);
    const adapter = new KimiAdapter();

    const first = await collect(
      adapter.run({ runId: 'r1', prompt: 'Reply with exactly: BRIDGE-SMOKE-1', cwd: dir }).events,
    );
    const system = first.find((e) => e.type === 'system');
    const finalText = first.find((e) => e.type === 'final_text');
    const done = first.find((e) => e.type === 'done');
    expect(system?.resumeHandle).toMatch(/^session_/);
    expect(finalText?.content).toContain('BRIDGE-SMOKE-1');
    expect(done?.terminationReason).toBe('normal');

    const second = await collect(
      adapter.run({
        runId: 'r2',
        prompt: 'What exact token did I ask you to reply with earlier? Answer with just the token.',
        cwd: dir,
        resumeHandle: system!.resumeHandle!,
      }).events,
    );
    const secondFinal = second.find((e) => e.type === 'final_text');
    expect(secondFinal?.content).toContain('BRIDGE-SMOKE-1');
  }, 180_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
