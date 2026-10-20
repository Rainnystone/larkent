import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (!pidFile) process.exit(2);
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
if (!child.pid) process.exit(1);
writeFileSync(pidFile, String(child.pid));
process.stdout.write('ready\n');
setInterval(() => {}, 1_000_000);
