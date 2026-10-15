import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(
  tmpdir(),
  'larkent-xdg-runtime',
  `${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}`,
);
mkdirSync(dir, { recursive: true });
process.env.XDG_RUNTIME_DIR = dir;
