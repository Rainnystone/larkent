#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0-e2e-fake');
  process.exit(0);
}
if (argv.includes('--help')) {
  console.log('Usage: fake-cli (scripted JSONL)');
  process.exit(0);
}

const record = process.env.LARKENT_E2E_FAKE_RECORD;
if (record) {
  writeFileSync(record, JSON.stringify({ argv, pid: process.pid }));
}

const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
console.log(
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: session,
    model: 'e2e-fake',
  }),
);
console.log(
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'e2e-fake-ok' }] },
  }),
);
console.log(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'e2e-fake-ok',
    session_id: session,
  }),
);
process.exit(0);
