import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';

describe('Claude local session history', () => {
  const cleanup: string[] = [];

  beforeEach(() => { vi.stubEnv('CLAUDE_CONFIG_DIR', undefined); });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('uses Claude project directory encoding for punctuation in cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/Users/example/.lark-channel-workspaces/claude/default_open.sdks';
    const projectDir = join(
      home,
      '.claude',
      'projects',
      '-Users-example--lark-channel-workspaces-claude-default-open-sdks',
    );
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, 'session-a.jsonl');
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: 'user', message: { content: 'resume me' } })}\n`,
      'utf8',
    );
    await utimes(sessionPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    await expect(listRecentSessions(cwd, 5)).resolves.toEqual([
      {
        sessionId: 'session-a',
        mtime: Date.parse('2026-01-01T00:00:00Z'),
        preview: 'resume me',
        lineCount: 1,
      },
    ]);
  });

  it('reads only the configured Claude directory rather than mixing the default identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: () => home }));
    const custom = join(home, 'custom 中文 config');
    vi.stubEnv('CLAUDE_CONFIG_DIR', custom);
    for (const [root, id] of [[join(home, '.claude'), 'default-session'], [custom, 'custom-session']]) {
      const dir = join(root!, 'projects', '-repo');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { content: id } }) + '\n');
    }
    const { listRecentSessions } = await import('../../../src/session/history.js');
    expect((await listRecentSessions('/repo', 5)).map(entry => entry.sessionId)).toEqual(['custom-session']);
  });

  it('finds the canonical CLI project when cwd is a filesystem alias', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: () => home }));
    const target = join(home, 'project');
    const alias = join(home, 'project alias');
    await mkdir(target);
    await symlink(target, alias, 'junction');
    // Native Claude stores the canonical cwd with non-ASCII/punctuation replaced.
    const nativeKey = (await realpath(target)).replace(/[^A-Za-z0-9]/g, '-');
    const project = join(home, '.claude', 'projects', nativeKey);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'canonical-session.jsonl'), JSON.stringify({ type: 'user', message: { content: 'canonical' } }) + '\n');
    const { listRecentSessions } = await import('../../../src/session/history.js');
    expect((await listRecentSessions(alias, 5)).map(entry => entry.sessionId)).toEqual(['canonical-session']);
  });

  it.skipIf(process.platform === 'win32')('surfaces invalid cwd traversal instead of silently returning no history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    const file = join(home, 'file');
    await writeFile(file, 'not a directory');
    const { listRecentSessions } = await import('../../../src/session/history.js');
    await expect(listRecentSessions(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('summarizes bridge prompts using the real user input section', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/repo';
    const projectDir = join(home, '.claude', 'projects', '-repo');
    await mkdir(projectDir, { recursive: true });
    const prompt = buildAgentPrompt({
      context: {
        chatId: 'oc_secret',
        chatType: 'p2p',
        senderId: 'ou_secret',
        source: 'im',
      },
      instructions: ['internal bridge instruction'],
      userInput: '真实用户问题\n\n第二行',
    });
    await writeFile(
      join(projectDir, 'session-a.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`,
      'utf8',
    );

    const sessions = await listRecentSessions(cwd, 5);

    expect(sessions[0]?.preview).toBe('真实用户问题 第二行');
  });
});
