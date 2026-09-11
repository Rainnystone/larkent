import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('README runtime contract', () => {
  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const docs = await readDocs();

    for (const phrase of [
      'per-profile service',
      'workspaces.default',
      '/invite user',
      '/remove user',
      '/invite group',
      '/remove group',
      '/invite all group',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli identity policy',
      'profile-local lark-cli directory',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('does not document trusted or allowed directory authorization', async () => {
    const docs = await readDocs();

    for (const phrase of [
      '允许访问目录',
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'allowed directory',
      'allowed directories',
      'trusted directory',
      'safe directory',
    ]) {
      expect(docs).not.toContain(phrase);
    }
  });

  it('documents access control commands instead of config-only access management', async () => {
    const docs = await readDocs();

    expect(docs).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(docs).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const docs = await readDocs();

    expect(docs).toContain('Cloud-doc comments are document-scoped');
    expect(docs).toContain('云文档评论按文档权限生效');
    expect(docs).not.toContain('comments.enabled');
    expect(docs).not.toContain('comments.rateLimit');
    expect(docs).not.toContain('/doc ws bind');
  });

  it('presents Larkent, credits its inspiration, and names all five CLI agents', async () => {
    const [en, zh, pkgRaw, context] = await Promise.all([
      readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../CONTEXT.md', import.meta.url), 'utf8'),
    ]);
    const pkg = JSON.parse(pkgRaw) as {
      description: string;
      repository: { url: string };
      bugs: { url: string };
      homepage: string;
    };

    for (const doc of [en, zh]) {
      expect(doc.split(/\r?\n/)[0]).toBe('# Larkent: Agent for lark');
      expect(doc).toContain('https://github.com/zarazhangrui/lark-coding-agent-bridge');
      expect(doc).toContain('(docs/agent-setup.md)');
      expect(doc).toContain('(docs/operations.md)');
      expect(doc).toContain('--domain all');
      for (const agent of ['Claude Code', 'Codex CLI', 'Kimi Code', 'Grok Build', 'Cursor CLI']) {
        expect(doc).toContain(agent);
      }
      expect(doc).not.toContain('SpaceXAI');
      expect(doc).not.toContain('feedback-group-qr');
      expect(doc).not.toContain('larkent-for-grokbot');
      expect(doc).not.toMatch(/\]\((?:file:\/\/|\/(?!\/)|[A-Za-z]:\\)/);
    }
    expect(en).toContain('architectural refactor');
    expect(zh).toContain('架构重构');
    expect(context).toContain('Larkent connects CLI coding agents');
    expect(context).toContain('"default agent". There is none.');
    expect(pkg.description).toBe('Bridge Feishu/Lark bots to CLI coding agents');
    expect(pkg.repository.url).toBe('git+https://github.com/Rainnystone/larkent.git');
    expect(pkg.bugs.url).toBe('https://github.com/Rainnystone/larkent/issues');
    expect(pkg.homepage).toBe('https://github.com/Rainnystone/larkent#readme');
  });

  it('documents one turn as one bridge-owned final reply', async () => {
    const operations = await readFile(new URL('../../../docs/operations.md', import.meta.url), 'utf8');

    expect(operations).toContain('one bridge-owned final reply');
    expect(operations).toContain('must not post the final answer');
  });

  it('documents self-heal recovery and a generic staged rollout', async () => {
    const operations = await readFile(new URL('../../../docs/operations.md', import.meta.url), 'utf8');

    expect(operations).toContain('keepalive.wake-up` or `ws.reconnected');
    expect(operations).toContain('enable on one profile, watch one recovery cycle, then the others');
  });

  it('documents canonical permissions instead of recommending legacy sandbox config', async () => {
    const docs = await readDocs();

    expect(docs).toContain('"permissions"');
    expect(docs).toContain('"defaultAccess": "full"');
    expect(docs).toContain('"maxAccess": "full"');
    expect(docs).toContain('legacy `sandbox`');
    expect(docs).toContain('旧版 `sandbox`');
    expect(docs).not.toContain('"sandbox"');
  });
});

async function readDocs(): Promise<string> {
  const [en, zh, operations] = await Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/operations.md', import.meta.url), 'utf8'),
  ]);
  return `${en}\n${zh}\n${operations}`;
}
