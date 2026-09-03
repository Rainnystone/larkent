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

  it('does not keep hand-written unions of the five agent kinds outside the registry', () => {
    const kind = String.raw`['"](?:claude|codex|kimi|grok|cursor)['"]`;
    const union = new RegExp(`${kind}(?:\\s*\\|\\s*${kind}){4}`, 'g');
    const comparison = new RegExp(
      `(?:===|!==)\\s*${kind}(?:[\\s\\S]{0,120}(?:===|!==)\\s*${kind}){4}`,
      'g',
    );
    const allowed = new Set(['src/agent/registry.ts']);
    const files = [...collectTsFiles('src'), ...collectTsFiles('web/src')].filter(
      (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
    );
    const stray: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      const source = read(file);
      const matches = [...(source.match(union) ?? []), ...(source.match(comparison) ?? [])];
      for (const match of matches) {
        const found = new Set(
          [...match.matchAll(/['"](claude|codex|kimi|grok|cursor)['"]/g)].map((item) => item[1]),
        );
        if (found.size === 5) stray.push(`${file}: ${match.replace(/\s+/g, ' ')}`);
      }
    }
    expect(stray, stray.join('\n')).toEqual([]);
  });

  it('does not fall through a missing AgentKind to claude', () => {
    const migrate = read('src/config/migrate-v2.ts');
    const runtime = read('src/runtime/profile-runtime.ts');
    expect(migrate).not.toMatch(/opts\.agentKind \?\? ['"]claude['"]/);
    expect(runtime).not.toMatch(/requestedAgent \?\? ['"]claude['"]/);
    expect(migrate).toContain('requireAgentKind(opts.agentKind ?? profile)');
    expect(runtime).toContain('requireAgentKind(requestedAgent ?? profile)');
  });

  it('starts the onboard wizard with no selected agent kind', () => {
    const source = read('web/src/views/OnboardWizard.tsx');
    expect(source).toMatch(/useState<AgentKind \| "">\(""\)/);
    expect(source).not.toMatch(/useState<AgentKind>\("grok"\)/);
    expect(source).not.toMatch(/setAgentKind\("grok"\)/);
    expect(source).toContain('AGENT_KINDS.map');
    const types = read('web/src/lib/types.ts');
    expect(types).toMatch(/export type \{ AgentKind \} from/);
    expect(types).not.toMatch(/export type AgentKind =/);
    const cli = read('src/runtime/profile-runtime.ts');
    expect(cli).toContain('AGENT_KINDS.map');
    expect(cli).not.toMatch(/initialValue:\s*detected/);
  });

  it('persists profile runtime state through atomic 0600 writes', () => {
    for (const file of ['src/session/store.ts', 'src/workspace/store.ts', 'src/card/callback-store.ts']) {
      const source = read(file);
      expect(source, file).toContain('writeFileAtomic');
      expect(source, file).toContain('mode: 0o600');
      expect(source, file).not.toMatch(/\bwriteFile\(/);
    }
  });
});
