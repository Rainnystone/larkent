import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../../src/agent/antigravity/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

// Smoke test against the real `agy` binary. Skipped unless explicitly
// enabled: it spends model quota and requires a logged-in Antigravity CLI.
// Uses Claude Sonnet rather than Gemini Flash: some networks return
// FAILED_PRECONDITION "User location is not supported" for Gemini.
//   ANTIGRAVITY_REAL_SMOKE=1 npx vitest run tests/process/antigravity-real.smoke.test.ts
const RUN = process.env.ANTIGRAVITY_REAL_SMOKE === '1';
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('AntigravityAdapter real binary smoke', () => {
  it('runs a prompt and resumes the conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-real-'));
    dirs.push(dir);
    const adapter = new AntigravityAdapter();

    const first = await collect(
      adapter.run({
        runId: 'r1',
        prompt: 'Reply with exactly: BRIDGE-SMOKE-1. Do not use tools.',
        cwd: dir,
        model: 'claude-sonnet-4-6',
      }).events,
    );
    const system = first.find((e) => e.type === 'system');
    const finalText = first.find((e) => e.type === 'final_text');
    const done = first.find((e) => e.type === 'done');
    expect(system?.resumeHandle).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(finalText?.content).toContain('BRIDGE-SMOKE-1');
    expect(done?.terminationReason).toBe('normal');

    const second = await collect(
      adapter.run({
        runId: 'r2',
        prompt: 'What exact token did I ask you to reply with earlier? Answer with just the token.',
        cwd: dir,
        resumeHandle: system!.resumeHandle!,
        model: 'claude-sonnet-4-6',
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
