import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/agent/types.ts'), 'utf8');

describe('agent type contract', () => {
  it('uses a single resumeHandle on system and done events', () => {
    expect(source).toMatch(/type:\s*'system'[^|]*resumeHandle\?:\s*string/s);
    expect(source).toMatch(/type:\s*'done'[^|]*resumeHandle\?:\s*string/s);
    expect(source).toMatch(/type:\s*'usage'[^|]*costUsd\?:\s*number/s);
    expect(source).not.toMatch(/\bsessionId\b/);
    expect(source).not.toMatch(/\bthreadId\b/);
  });

  it('requires termination reasons on terminal events', () => {
    expect(source).toMatch(/type:\s*'done'[^|]*terminationReason:\s*'normal'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
    expect(source).toMatch(/type:\s*'error'[^|]*terminationReason:\s*'failed'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
  });

  it('requires runId on run options and run handles', () => {
    expect(source).toMatch(/interface AgentRunOptions[^}]*runId:\s*string/s);
    expect(source).toMatch(/interface AgentRun[^}]*readonly runId:\s*string/s);
    expect(source).toMatch(/interface AgentRunOptions[^}]*resumeHandle\?:\s*string/s);
  });
});
