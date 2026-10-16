import { spawn } from 'node:child_process';

const CURSOR_STALL = 'RetriableError: Connection stalled repeatedly\n';
const CURSOR_AUTH =
  "Your stored authentication is invalid or has expired. Please run 'agent login' to authenticate.\n";
const AGY_PRINT_TIMEOUT =
  '[agy] print timeout after 5m0s with turn in progress; returning partial output\n';
const AGY_INTERRUPTED = 'error: interrupted\n';

const modeFlag = process.argv.indexOf('--mode');
const separator = process.argv.indexOf('--');
const mode = modeFlag >= 0 ? process.argv[modeFlag + 1] : undefined;
const rest = separator >= 0 ? process.argv.slice(separator + 1) : [];
const target = rest[0];
const args = rest.slice(1);

if (!mode) {
  console.error('run-fault.ts requires --mode');
  process.exit(2);
}

forwardSignals();

switch (mode) {
  case 'cursor-stall':
    process.stderr.write(CURSOR_STALL);
    process.exit(1);
    break;
  case 'cursor-auth':
    // Simulate only. Never invoke a real logout or mutate CLI auth state.
    process.stderr.write(CURSOR_AUTH);
    process.exit(1);
    break;
  case 'agy-print-timeout':
    process.stdout.write(
      `${JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: '', print_timeout: true },
      })}\n`,
    );
    process.stderr.write(AGY_PRINT_TIMEOUT);
    process.exit(0);
    break;
  case 'agy-interrupted':
    process.stderr.write(AGY_INTERRUPTED);
    process.exit(1);
    break;
  case 'hang':
    setInterval(() => undefined, 60_000);
    break;
  default: {
    if (mode.startsWith('delay:')) {
      const seconds = Number(mode.slice('delay:'.length));
      if (!target) {
        console.error('delay fault requires a shim target');
        process.exit(2);
      }
      await sleep(seconds * 1000);
      const child = spawn(target, args, { stdio: 'inherit' });
      const code = await waitForChild(child);
      process.exit(code);
      break;
    }
    console.error(`unknown fault mode: ${mode}`);
    process.exit(2);
  }
}

type ForwardedSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

function forwardSignals(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      process.exit(signalExit(signal));
    });
  }
}

function signalExit(signal: ForwardedSignal): number {
  switch (signal) {
    case 'SIGHUP':
      return 129;
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    default: {
      const _never: never = signal;
      return _never;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') {
        resolve(signalExit(signal));
        return;
      }
      resolve(signal ? 1 : (code ?? 1));
    });
    child.once('error', () => resolve(1));
  });
}
