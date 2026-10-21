import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SESSION_ROOTS = ['.trae', 'draft_716b277c_folder'];
const IGNORED_SESSION_PATHS = [
  '.trae/documents/ci-speedup-plan.md',
  'draft_716b277c_folder/draft.xml',
  'draft_716b277c_folder/.presentation-decision.json',
];

describe('session working files', () => {
  it('does not track Trae notes or generated presentation drafts', () => {
    const tracked = execFileSync('git', ['ls-files', '--', ...SESSION_ROOTS], {
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });

  it('gitignores Trae notes and generated draft folders', () => {
    for (const path of IGNORED_SESSION_PATHS) {
      const ignored = execFileSync('git', ['check-ignore', '-v', path], { encoding: 'utf8' });
      expect(ignored, path).toMatch(/\.gitignore:\d+:/);
    }
  });
});
