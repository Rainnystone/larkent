import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const e2eRoot = join(repoRoot, 'e2e');

/** Feishu-shaped ids that must never be committed under e2e/. */
const REAL_ID = /\b(?:cli|oc|ou)_[A-Za-z0-9]{8,}\b/;

describe('test-bridge repo hygiene', () => {
  it('gitignores e2e/.local so live tester values stay untracked', () => {
    const ignored = execFileSync(
      'git',
      ['check-ignore', '-v', 'e2e/.local/test-bridge.json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(ignored).toMatch(/e2e\/\.local/);
  });

  it('keeps committed e2e/ files free of real Feishu id shapes', async () => {
    const hits: string[] = [];
    for await (const file of walkCommittedE2e(e2eRoot)) {
      const text = await readFile(file, 'utf8');
      if (REAL_ID.test(text)) {
        hits.push(`${relative(repoRoot, file)}: ${text.match(REAL_ID)?.[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

async function* walkCommittedE2e(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const rel = relative(e2eRoot, path).split(sep);
    if (rel[0] === '.local') continue;
    if (entry.isDirectory()) {
      yield* walkCommittedE2e(path);
      continue;
    }
    if (entry.isFile()) {
      const info = await stat(path);
      if (info.isFile()) yield path;
    }
  }
}
