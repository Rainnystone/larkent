import { writeFile } from 'node:fs/promises';
import { startFaultProxy } from './proxy';
import { proxyStatePath, readProxyMode } from './proxy-control';

const flag = process.argv.indexOf('--state-dir');
const stateDirArg = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!stateDirArg) {
  console.error('proxy-process.ts requires --state-dir');
  process.exit(2);
}
const stateDir = stateDirArg;

const initial = await readProxyMode(stateDir);
const proxy = await startFaultProxy({
  mode: initial.mode === 'eai_again' ? 'off' : initial.mode,
  delayMs: initial.delayMs,
});
if (initial.mode === 'eai_again') {
  proxy.setMode('eai_again');
}
await writeFile(
  proxyStatePath(stateDir),
  `${JSON.stringify({ pid: process.pid, url: proxy.url })}\n`,
  { mode: 0o600 },
);

const timer = setInterval(() => {
  void syncMode();
}, 100);

async function syncMode(): Promise<void> {
  const next = await readProxyMode(stateDir);
  proxy.setMode(next.mode, {
    ...(next.delayMs !== undefined ? { delayMs: next.delayMs } : {}),
    hosts: next.hosts ?? [],
  });
}

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await proxy.close();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}
