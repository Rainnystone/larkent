import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (!pidFile) process.exit(2);
// Windows has no `sleep` binary. A hidden node process is the same
// non-stdout grandchild the POSIX `sleep` is: stop must reap it with the tree.
const child = process.platform === 'win32'
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  : spawn('sleep', ['60'], { stdio: 'ignore' });
if (!child.pid) process.exit(1);
writeFileSync(pidFile, String(child.pid));
process.stdout.write('ready\n');
setInterval(() => {}, 1_000_000);
