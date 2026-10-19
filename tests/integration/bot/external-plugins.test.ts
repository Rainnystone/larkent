import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import { writeExternalPlugin } from '../../helpers/external-plugin';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

let client: Awaited<ReturnType<typeof buildToolProcess>>;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { client = await buildToolProcess(); });
afterAll(async () => { await client.cleanup(); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); sdk.channel = undefined; });

it('shares one host installation across profiles and executes its located script using the runtime tool process', async () => {
  const tmp = await createTmpProfile('external-plugins-'); cleanup.push(tmp.cleanup);
  const root = await writeExternalPlugin(join(tmp.root, 'fixture-tools-v1'));
  await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [root] }));
  for (const profile of ['synthetic-a', 'synthetic-b']) {
    const h = await harness(tmp, profile, async (opts, call) => {
      expect(opts.prompt).toContain('Calculate a synthetic fixture value');
      expect(opts.prompt).not.toContain('fixture-tools:calculate');
      expect(opts.prompt).not.toContain('Read data.json');
      const listed = await call('plugins.list');
      expect(listed.data.plugins.map((p: { id: string }) => p.id)).toEqual(['automation', 'fixture-tools']);
      expect(await call('plugins.inspect', { plugin: 'fixture' })).toMatchObject({ category: 'ok', data: { id: 'fixture-tools' } });
      const body = await call('plugins.read', { skill: 'compute' });
      expect(body).toMatchObject({ category: 'ok', data: { content: expect.stringContaining('existing runtime shell') } });
      const script = await call('plugins.read', { skill: 'fixture-tools:calculate', resource: 'skills/calculate/scripts/value.mjs', reference: body.data.source.reference });
      expect(script).toMatchObject({ category: 'ok', data: { source: { type: 'script', version: '1.0.0' } } });
      // This is the adapter's existing tool process, not a bridge execution operation.
      const actual = await promisify(execFile)(process.execPath, [script.data.source.path], { cwd: tmp.workspace });
      expect(actual.stderr).toBe('');
      expect(JSON.parse(actual.stdout)).toEqual({ result: 42, doubled: 84 });
      return `Actual script result for ${profile}: ${actual.stdout.trim()}`;
    });
    await h.message('calculate fixture value');
    expect(h.bodies()).toContain('"result":42,"doubled":84');
  }
}, 30000);

async function harness(tmp: Awaited<ReturnType<typeof createTmpProfile>>, profile: string,
  work: (opts: AgentRunOptions, call: (operation: string, params?: Record<string, unknown>) => Promise<any>) => Promise<string>) {
  const cfg = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: '/synthetic/codex', inheritCodexHome: false },
    accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_synthetic'], allowedChats: ['oc_synthetic'] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true, cotMessages: 'off' },
  });
  cfg.workspaces.default = tmp.workspace;
  let agentError: unknown;
  let count = 0;
  const agent: AgentAdapter = {
    id: 'codex', displayName: 'Controlled runtime tool seam', isAvailable: async () => true,
    run(opts) {
      return { runId: opts.runId, stop: async () => {}, waitForExit: async () => true,
        events: (async function* (): AsyncIterable<AgentEvent> {
          yield { type: 'system', resumeHandle: 'synthetic-external-thread' };
          try {
            const answer = await work(opts, async (operation, params = {}) => {
              const child = await client.call({ version: 1, operation, params }, opts.toolEnv);
              expect(child.code).toBe(0); expect(child.stderr).toBe('');
              return JSON.parse(child.stdout);
            });
            yield { type: 'final_text', content: answer };
          } catch (error) { agentError = error; yield { type: 'final_text', content: 'Synthetic adapter failed' }; }
          yield { type: 'done', terminationReason: 'normal' };
        })(),
      };
    },
  };
  const channel = createRecordingLarkChannel({ chatMode: 'group', botIdentity: { openId: 'ou_synthetic_bot', name: 'Synthetic' } });
  sdk.channel = channel;
  const sessions = new SessionStore(join(tmp.profile, `${profile}-sessions.json`));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, `${profile}-catalog.json`)); await sessionCatalog.load();
  const bridge = await startChannel({ cfg, agent, sessions, sessionCatalog, workspaces: new WorkspaceStore(join(tmp.profile, `${profile}-workspaces.json`)), probe: async () => true,
    appPaths: { mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, 'salt') },
    controls: { profile, profileConfig: cfg, cfg, botOwnerId: 'ou_synthetic', ownerRefreshState: 'ok', async refreshOwner() {}, async restart() {}, async exit() {}, configPath: join(tmp.root, 'config.json'), processId: `synthetic-${profile}` },
  });
  cleanup.push(() => bridge.disconnect());
  return {
    bodies: () => channel.sent.map(s => typeof s.content === 'object' && s.content && 'markdown' in s.content ? s.content.markdown : JSON.stringify(s.content)).join('\n'),
    async message(content: string) {
      const before = channel.sent.length;
      await channel.handlers.message?.({ messageId: `om_synthetic_${++count}`, content, chatId: 'oc_synthetic', chatType: 'group', senderId: 'ou_synthetic', senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: true, createTime: Date.now(), raw: { sender: { sender_type: 'user' } } } as unknown as NormalizedMessage);
      await vi.waitFor(() => expect(agentError || channel.sent.length > before).toBeTruthy(), { timeout: 12000 });
      if (agentError) throw agentError;
    },
  };
}
