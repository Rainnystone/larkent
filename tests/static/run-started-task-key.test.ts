import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('run started taskKey call site', () => {
  it('computes IM taskKey from profile, full chatId, and the first flushed message id', () => {
    const source = read('src/bot/channel.ts');
    expect(source).toMatch(
      /taskKey:\s*computeRunTaskKey\(\s*controls\.profile\s*,\s*chatId\s*,\s*firstMsg\.messageId\s*\)/,
    );
    expect(source).toMatch(/from ['"]\.\.\/runtime\/task-key['"]/);
  });

  it('keeps taskKey and task_key out of logger ID_KEYS so they survive sanitization', () => {
    const logger = read('src/core/logger.ts');
    const block = logger.match(/const ID_KEYS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    expect(block?.[1]).not.toMatch(/taskKey|task_key/);
  });
});
