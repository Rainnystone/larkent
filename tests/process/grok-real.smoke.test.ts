import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

// Smoke test against the real `grok` binary. Skipped unless explicitly
// enabled: it spends model quota and requires a logged-in Grok CLI.
//   GROK_REAL_SMOKE=1 npx vitest run tests/process/grok-real.smoke.test.ts
const RUN = process.env.GROK_REAL_SMOKE === '1';
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('GrokAdapter real binary smoke', () => {
  it('runs a prompt and resumes the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-real-'));
    dirs.push(dir);
    const adapter = new GrokAdapter();

    const first = await collect(
      adapter.run({ runId: 'r1', prompt: 'Reply with exactly: BRIDGE-SMOKE-1', cwd: dir }).events,
    );
    const system = first.find((e) => e.type === 'system');
    const finalText = first.find((e) => e.type === 'final_text');
    const done = first.find((e) => e.type === 'done');
    expect(system?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(finalText?.content).toContain('BRIDGE-SMOKE-1');
    expect(done?.terminationReason).toBe('normal');

    const second = await collect(
      adapter.run({
        runId: 'r2',
        prompt: 'What exact token did I ask you to reply with earlier? Answer with just the token.',
        cwd: dir,
        sessionId: system!.sessionId!,
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
