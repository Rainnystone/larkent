import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommentEvent } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('comment access fence', () => {
  it('rejects an @bot comment when the fence is on and the sender is not allowlisted', async () => {
    const h = await createHarness();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    await handleCommentMention(
      h.deps(event({ operator: { openId: 'ou-outsider' } })),
    );

    expect(h.channel.calls).toEqual([]);
    expect(h.agent.runOptions).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      'comment',
      'skip',
      expect.objectContaining({ reason: 'denied-user' }),
    );
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: { calls: string[] };
  agent: FakeAgentAdapter;
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('comment-access-fence-');
  const calls: string[] = [];
  const rawClient = {
    async request() {
      return {};
    },
    wiki: {
      v2: {
        space: {
          async getNode() {
            calls.push('wiki.getNode');
            throw Object.assign(new Error('api 131005'), { response: { data: { code: 131005 } } });
          },
        },
      },
    },
    drive: {
      v1: {
        fileComment: {
          async get() {
            calls.push('fileComment.get');
            return {
              data: {
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-1',
                      content: {
                        elements: [{ type: 'text_run', text_run: { text: '@bot question' } }],
                      },
                    },
                  ],
                },
              },
            };
          },
          async list() {
            calls.push('fileComment.list');
            return { data: { items: [] } };
          },
          async create() {
            calls.push('fileComment.create');
            return {};
          },
        },
      },
    },
  };
  const channel = {
    calls,
    comments: makeFakeCommentSurface(rawClient),
    rawClient,
  };
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'answer' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: {
      fence: { enabled: true },
      allowedUsers: ['ou-allowed'],
      allowedChats: ['doc-token'],
    },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns,
    createRunId: () => 'comment-run-1',
  });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    deps: (evt) => ({
      channel: channel as unknown as Parameters<typeof handleCommentMention>[0]['channel'],
      evt,
      agent,
      sessions,
      workspaces,
      activeRuns,
      executor,
      controls: {
        profile: 'claude',
        profileConfig,
        botOwnerId: 'ou-owner',
        ownerRefreshState: 'ok',
        async refreshOwner() {},
        configPath: join(tmp.profile, 'config.json'),
        cfg: profileConfig,
        processId: 'proc-1',
        async restart() {},
        async exit() {},
      },
    }),
  };
}

function event(overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment-1',
    replyId: 'reply-1',
    mentionedBot: true,
    operator: { openId: 'ou-user' },
    ...overrides,
  } as CommentEvent;
}
