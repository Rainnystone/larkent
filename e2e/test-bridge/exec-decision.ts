import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShimDecision, type ShimDecision } from './decide';

const file = process.argv[2];
if (!file) {
  console.error('exec-decision.ts requires a decision file');
  process.exit(2);
}

const decision = parseShimDecision(readFileSync(file, 'utf8'));
await applyShimDecision(decision);

async function applyShimDecision(next: ShimDecision): Promise<void> {
  if (next.action === 'exec') {
    await run(next.target, next.args);
    return;
  }
  if (next.mode.startsWith('delay:')) {
    const seconds = Number(next.mode.slice('delay:'.length));
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.error(`invalid delay: ${next.mode}`);
      process.exit(2);
    }
    await sleep(seconds * 1000);
    await run(next.target, next.args);
    return;
  }
  if (next.mode === 'hang') {
    // A pending Promise does not keep Node's event loop alive; a timer does.
    setInterval(() => undefined, 60_000);
    return;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  await run(process.execPath, [
    tsxCli,
    join(dir, 'run-fault.ts'),
    '--mode',
    next.mode,
    '--',
    next.target,
    ...next.args,
  ]);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // child already gone
      }
    };
    process.on('SIGTERM', () => forward('SIGTERM'));
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGHUP', () => forward('SIGHUP'));
    child.on('error', (err) => {
      console.error(err.message);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') process.exit(143);
      if (signal === 'SIGINT') process.exit(130);
      if (signal === 'SIGHUP') process.exit(129);
      if (signal) process.exit(1);
      if (code === 0) {
        resolve();
        return;
      }
      process.exit(code ?? 1);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
