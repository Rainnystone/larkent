import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const collectTsFiles = (path: string): string[] => {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return [];

  if (statSync(fullPath).isFile()) {
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  }

  return readdirSync(fullPath)
    .flatMap((entry) => collectTsFiles(join(path, entry)))
    .sort();
};

describe('static architecture contracts', () => {
  it('keeps shared agent definition types independent of registry modules', () => {
    const definitionPath = 'src/agent/definition.ts';
    expect(existsSync(join(root, definitionPath)), definitionPath).toBe(true);

    const source = read(definitionPath);
    expect(source).not.toMatch(/from ['"].*\/(?:registry|capability|models)(?:\.js)?['"]/);
  });

  it('keeps adapter metadata independent of the central registry', () => {
    for (const kind of ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const) {
      const metadataPath = `src/agent/${kind}/metadata.ts`;
      expect(existsSync(join(root, metadataPath)), metadataPath).toBe(true);
      expect(read(metadataPath), metadataPath).not.toMatch(
        /from ['"].*\/(?:registry|capability|models)(?:\.js)?['"]|\bdescriptorFor\b|\bAGENT_REGISTRY\b/,
      );
    }
  });

  it('keeps Cursor adapter metadata independent of the central registry', () => {
    const adapterPath = 'src/agent/cursor/adapter.ts';
    expect(read(adapterPath), adapterPath).not.toMatch(
      /from ['"].*\/registry(?:\.js)?['"]|\bdescriptorFor\b|\bAGENT_REGISTRY\b/,
    );
  });

  it('does not route production runs by importing Codex internals in shared bot/card code', () => {
    const sharedFiles = [
      ...collectTsFiles('src/bot'),
      ...collectTsFiles('src/card'),
      'src/commands/index.ts',
    ];
    for (const file of sharedFiles) {
      expect(read(file), file).not.toMatch(/agent\/codex/);
      expect(read(file), file).not.toMatch(/agent\/grok/);
      expect(read(file), file).not.toMatch(/agent\/kimi/);
      expect(read(file), file).not.toMatch(/agent\/cursor/);
    }
  });

  it('does not keep legacy open access semantics in config helpers', () => {
    const schema = read('src/config/schema.ts');
    expect(schema).not.toMatch(/legacy-open|access\.semantics/);

    const legacyOpenAccessPatterns = [
      /Empty\/undefined = allow everyone/,
      /Empty\/undefined =\s*\n\s*\* respond in all chats it's invited to\./,
      /Empty \/\s*\n\s*\* undefined = no admin restriction/,
      /Empty list = allow all/,
      /if \(!list \|\| list\.length === 0\) return true;/,
    ];
    for (const pattern of legacyOpenAccessPatterns) {
      expect(schema).not.toMatch(pattern);
    }
  });

  it('persists profile runtime state through atomic 0600 writes', () => {
    for (const file of ['src/session/store.ts', 'src/workspace/store.ts', 'src/card/callback-store.ts']) {
      const source = read(file);
      expect(source, file).toContain('writeFileAtomic');
      expect(source, file).toContain('mode: 0o600');
      expect(source, file).not.toMatch(/\bwriteFile\(/);
    }
  });

  it('keeps the five-kind union only in src/agent/registry.ts', () => {
    const files = [
      ...collectTsFiles('src'),
      ...collectTsFiles('web/src'),
    ].filter((file) => file !== 'src/agent/registry.ts' && !file.endsWith('.d.ts'));
    const strayUnion =
      /['"](?:claude|codex|kimi|grok|cursor)['"](?:\s*\|\s*['"](?:claude|codex|kimi|grok|cursor)['"]){4}/;
    for (const file of files) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(strayUnion);
    }
  });

  it('spawns agent CLIs only from JsonlCliRunner', () => {
    for (const kind of ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const) {
      for (const file of collectTsFiles(`src/agent/${kind}`)) {
        expect(read(file), file).not.toMatch(/\bspawnProcess\b/);
      }
    }
    expect(read('src/agent/runner/jsonl-cli-runner.ts')).toMatch(/\bspawnProcess\b/);
  });

  it('does not keep leftover usesNativeSessionId or usesFinalAnswerReply wrappers', () => {
    const forbidden = [/\busesNativeSessionId\b/, /\busesFinalAnswerReply\b/];
    const webFiles = collectTsFiles('web/src');
    expect(webFiles).toContain('web/src/views/OnboardWizard.tsx');
    const files = [...collectTsFiles('src'), ...webFiles];
    const stray: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const pattern of forbidden) {
        if (pattern.test(source)) stray.push(`${file}: ${pattern.source}`);
      }
    }
    expect(stray, stray.join('\n')).toEqual([]);
  });
});
