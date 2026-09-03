import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isCursorCliHelpText, looksLikeCursorBinary } from '../../../src/agent/cursor/binary';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

describe('isCursorCliHelpText', () => {
  it('requires Cursor-specific flags, not a generic agent banner', () => {
    expect(isCursorCliHelpText('agent 1.2.3\nUsage: agent [command]')).toBe(false);
    expect(
      isCursorCliHelpText(
        'Usage: agent [options]\n  --output-format <fmt>\n  --approve-mcps\n  stream-json',
      ),
    ).toBe(true);
  });
});

describe('looksLikeCursorBinary', () => {
  it('accepts a binary whose version names Cursor', async () => {
    const path = await writeFake('#!/usr/bin/env node\nconsole.log("cursor-agent 2026.08.28");\n');
    expect(await looksLikeCursorBinary(path)).toBe(true);
  });

  it('rejects an unrelated agent whose help has no Cursor flags', async () => {
    const path = await writeFake(
      [
        '#!/usr/bin/env node',
        'if (process.argv.includes("--help")) {',
        '  console.log("Usage: agent <task>");',
        '} else {',
        '  console.log("agent 1.0.0");',
        '}',
      ].join('\n'),
    );
    expect(await looksLikeCursorBinary(path)).toBe(false);
  });

  it('accepts a date-like version only when --help looks like Cursor CLI', async () => {
    const path = await writeFake(
      [
        '#!/usr/bin/env node',
        'if (process.argv.includes("--help")) {',
        '  console.log("Usage: agent -p --output-format stream-json --approve-mcps");',
        '} else {',
        '  console.log("2026.08.28-deadbeef");',
        '}',
      ].join('\n'),
    );
    expect(await looksLikeCursorBinary(path)).toBe(true);
  });
});

async function writeFake(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-binary-'));
  cleanup.push(dir);
  const path = join(dir, 'agent');
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
  return path;
}
