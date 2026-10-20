import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [role, pidFile] = process.argv.slice(2);
// Install the handler before announcing readiness. Every generation keeps the
// inherited stdout pipe open and survives the graceful signal.
process.on('SIGTERM', () => {
  if (role === 'leader') {
    process.stdout.write(JSON.stringify({ type: 'text', delta: 'graceful tail' }));
  }
});
setInterval(() => {}, 1000);

if (role === 'holder') {
  process.send([process.pid]);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), role === 'leader' ? 'middle' : 'holder'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  child.once('message', pids => {
    const tree = [process.pid, ...pids];
    if (role === 'leader') {
      writeFileSync(pidFile, JSON.stringify(tree));
      console.log(JSON.stringify({ type: 'text', delta: 'ready' }));
    } else {
      process.send(tree);
    }
  });
}
