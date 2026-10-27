import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runToolProcess } from '../../helpers/bridge-tool-process.js';

it('keeps a multibyte character intact when its bytes arrive in separate pipe chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-process-utf8-'));
  try {
    const script = join(dir, 'split-writer.mjs');
    // Split inside the first character so each stream's first chunk ends mid-sequence.
    await writeFile(script, `
      const bytes = Buffer.from('多份草稿与多项结果', 'utf8');
      const split = stream => new Promise(done => stream.write(bytes.subarray(0, 1), () => setTimeout(() => stream.write(bytes.subarray(1), done), 100)));
      await Promise.all([split(process.stdout), split(process.stderr)]);
    `);
    const result = await runToolProcess(script, '', {});
    expect(result).toEqual({ code: 0, stdout: '多份草稿与多项结果', stderr: '多份草稿与多项结果' });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
