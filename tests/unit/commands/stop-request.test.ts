import { afterEach, describe, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type UserActionContext, type Controls } from '../../../src/commands/index';
import { createDefaultProfileConfig, MEETING_DEFAULTS } from '../../../src/config/profile-schema';
import { attachMeetingAgent, meetingScopeId } from '../../../src/meeting/orchestrator';
import { MeetingSession } from '../../../src/meeting/session';
import { ResumeCandidates } from '../../../src/session/resume-candidates';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeAgent } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('stop request at each call site', () => {
  it('records user-stop on /stop', async () => {
    const h = await harness();
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run('/stop')).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'user-stop' });
  });

  it('records superseded(new) on /new', async () => {
    const h = await harness();
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run('/new')).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'superseded', by: 'new' });
  });

  it('records superseded(cd) on /cd', async () => {
    const h = await harness();
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'superseded', by: 'cd' });
  });

  it('records superseded(ws) on /ws use', async () => {
    const h = await harness();
    h.workspaces.setCwd('chat-1', await realpath(h.tmp.workspace));
    await expect(h.run('/ws save proj')).resolves.toBe(true);
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run('/ws use proj')).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'superseded', by: 'ws' });
  });

  it('records superseded(resume) on /resume use', async () => {
    const h = await harness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run('/resume use sess-1')).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'superseded', by: 'resume' });
  });

  it('records reconnect-command on /reconnect', async () => {
    const h = await harness();
    const handle = h.activeRuns.register('chat-1', h.agent.run({ runId: 'r', prompt: 'p' }));
    await expect(h.run('/reconnect')).resolves.toBe(true);
    expect(handle.stopRequest).toEqual({ type: 'reconnect-command' });
  });

  it('records meeting on an in-meeting stop word', async () => {
    const h = await harness();
    const session = new MeetingSession({
      client: { request: vi.fn(async () => ({ code: 0, data: {} }) as never) },
      meetingId: '70001',
      meetingNo: '123',
      config: { ...MEETING_DEFAULTS, trigger: '@bot' },
    });
    attachMeetingAgent({
      session,
      channel: h.channel as never,
      controls: h.controls,
      executor: { submit: async () => { throw new Error('unused'); } } as never,
      activeRuns: h.activeRuns,
      sessions: h.sessions,
      workspaces: h.workspaces,
    });
    const handle = h.activeRuns.register(meetingScopeId('70001'), h.agent.run({ runId: 'r', prompt: 'p' }));
    session.ingest({
      event_id: 'c-stop',
      activity_event_type: 'chat_received',
      chat_received_items: [{ content: '@bot stop', message_type: 1, sender: { open_id: 'ou-user', name: '甲' } }],
    });
    expect(handle.stopRequest).toEqual({ type: 'meeting' });
  });
});

async function harness(): Promise<{
  tmp: TmpProfile;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  channel: ReturnType<typeof createFakeChannel>;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  run: (content: string) => Promise<boolean>;
}> {
  const tmp = await createTmpProfile('stop-request-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  const cleanup = async (): Promise<void> => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  };
  cleanups.push(cleanup);

  return {
    tmp,
    activeRuns,
    agent,
    channel,
    sessions,
    workspaces,
    controls,
    run: (content: string) =>
      tryHandleCommand({
        origin: 'slash',
        resumeCandidates: new ResumeCandidates(),
        channel: channel as unknown as UserActionContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 24)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
