import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('stop request call sites', () => {
  it('sets a first-writer-wins reason at every production stop site', () => {
    const commands = read('src/commands/index.ts');
    const channel = read('src/bot/channel.ts');
    const meeting = read('src/meeting/orchestrator.ts');
    const executor = read('src/runtime/run-executor.ts');
    const spawn = read('src/platform/spawn.ts');
    const runner = read('src/agent/runner/jsonl-cli-runner.ts');

    expect(commands).toContain("interrupt(scope, { type: 'user-stop' })");
    expect(commands).toContain("supersedeSession(ctx.scope, { type: 'superseded', by: 'new' })");
    expect(commands).toContain("supersedeSession(ctx.scope, { type: 'superseded', by: 'cd' })");
    expect(commands).toContain("supersedeSession(ctx.scope, { type: 'superseded', by: 'ws' })");
    expect(commands).toContain("supersedeSession(ctx.scope, { type: 'superseded', by: 'resume' })");
    expect(commands).toContain("stopAll({ type: 'reconnect-command' })");
    expect(commands).toContain("requestStop(handle, { type: 'exit-command' })");
    expect(commands).toContain("restart({ stopReason: { type: 'account-restart' } })");
    expect(commands).toContain("interrupt(meetingScopeId(picked.session.meetingId), { type: 'meeting' })");

    expect(meeting).toContain("interrupt(meetingScopeId(session.meetingId), { type: 'meeting' })");
    expect(channel).toContain("restart({ stopReason: { type: 'keepalive-restart' } })");
    expect(channel).toContain("stopAll(opts?.stopReason ?? { type: 'shutdown-signal' })");
    expect(channel).toContain("requestStop(handle, { type: 'bridge-idle-watchdog' })");
    expect(channel).toMatch(/onConnectedTick:[\s\S]*recoverJournal\(\)/);
    expect(channel).toContain('noteTerminalStop(handle, evt)');
    expect(executor).toContain("requestStop(handle, { type: 'subscriber-abandoned' })");
    expect(executor).toContain('stopRequestFromTerminal(event)');

    expect(spawn).toContain('Turn journal reaps agent CLI orphans');
    expect(runner).toMatch(/detached:\s*true/);
  });
});
