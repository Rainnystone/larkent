import { spawn } from 'node:child_process';

const pidFile = process.argv[2];
if (!pidFile) process.exit(2);
// setsid(1) puts this grandchild in its own session. It records its pid only
// after ignoring SIGTERM, so a group-only stop leaves it alive.
const script = [
  'const fs = require("node:fs");',
  'process.on("SIGTERM", () => {});',
  'fs.writeFileSync(process.argv[1], String(process.pid));',
  'setInterval(() => {}, 1000);',
].join('');
const child = spawn('setsid', [process.execPath, '-e', script, pidFile], { stdio: 'ignore' });
child.on('error', () => process.exit(1));
if (!child.pid) process.exit(1);
setInterval(() => {}, 1_000_000);
