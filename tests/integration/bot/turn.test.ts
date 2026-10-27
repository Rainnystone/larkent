import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { CotClient } from '../../../src/bot/cot';
import { createContinuations } from '../../../src/bot/continuation';
import { describeRunOutcome } from '../../../src/bot/run-outcome';
import { capabilityForProfile } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { Outbox } from '../../../src/bot/outbox';
import { ProcessPool } from '../../../src/bot/process-pool';
import { executeTurn, turnStderrSignatures, type TurnResult } from '../../../src/bot/turn';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { replay, transcriptCase } from '../../helpers/transcript-replay';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('delivers a captured final-only chat answer once without opening progress', async () => {
  expectTypeOf<Extract<TurnResult, { ok: true }>>().not.toHaveProperty('execution');
  const h = await fixture();
  const result = await executeTurn({ run: h.run, delivery: h.delivery });
  expect(result.ok && result.state.terminal).toBe('done');
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'TRANSCRIPT-OK' }]);
  expect(h.channel.streams).toHaveLength(0);
  expect(h.journal.get('turn')?.outcome?.kind).toBe('completed');
});

it('honors the chat card target for a captured final-only answer', async () => {
  const h = await fixture();
  await executeTurn({ run: h.run, delivery: { ...h.delivery, replyMode: 'card' } });
  expect(h.channel.sent).toHaveLength(1);
  expect(h.channel.sent[0]?.content).toHaveProperty('card');
  expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('OK');
  expect(h.channel.streams).toHaveLength(0);
});

it('delivers captured final-only markdown without creating an empty stream', async () => {
  const h = await fixture();
  await executeTurn({ run: h.run, delivery: { ...h.delivery, replyMode: 'markdown' } });
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'TRANSCRIPT-OK' }]);
  expect(h.channel.streams).toHaveLength(0);
});

it('keeps a captured answer out of the separate CoT progress bubble', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, body: String(init?.body ?? '') });
    return new Response(JSON.stringify(url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'synthetic', expire: 7200 }
      : { code: 0, data: { cot_id: 'cot', message_id: 'progress' } }), { status: 200 });
  });
  const h = await fixture();
  await executeTurn({ run: h.run, delivery: { ...h.delivery, cot: {
    client: new CotClient({ tenant: 'feishu', appId: 'synthetic', appSecret: 'synthetic' }),
    detail: 'brief', inputPreview: 'Answer OK',
  } } });
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'TRANSCRIPT-OK' }]);
  expect(requests.some(row => row.url.includes('/complete/'))).toBe(true);
  expect(requests.map(row => row.body).join('\n')).not.toContain('TRANSCRIPT-OK');
});

it.each(['card', 'markdown'] as const)('streams captured narration once and delivers one separate %s answer', async replyMode => {
  const h = await fixture({ events: replay(transcriptCase('grok', 'narration-tool-answer')) });
  await executeTurn({ run: h.run, delivery: { ...h.delivery, replyMode } });
  expect(h.channel.streams).toHaveLength(1);
  const progress = JSON.stringify([h.channel.streams[0]?.cardUpdates, h.channel.streams[0]?.markdownContents]);
  expect(progress).toContain("I'll run `echo hello`");
  expect(progress).not.toContain('The shell printed:');
  expect(h.channel.sent).toHaveLength(1);
  expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('The shell printed:');
  expect(JSON.stringify(h.channel.sent[0]?.content)).not.toContain("I'll run");
});

it('recalls a progress stream whose visible content becomes empty', async () => {
  const h = await fixture({ events: [
    { type: 'text', delta: 'temporary progress' }, { type: 'done', terminationReason: 'normal' },
  ] });
  await executeTurn({ run: h.run, delivery: { ...h.delivery, replyMode: 'markdown',
    filterState: state => state.terminal === 'running' ? state : { ...state, blocks: [], finalText: undefined },
  } });
  expect(h.channel.streams).toHaveLength(1);
  expect(h.channel.callLog.filter(row => row.op === 'recall')).toEqual([
    { op: 'recall', messageId: h.channel.streams[0]?.messageId },
  ]);
});

it('delivers the same captured answer as an automation result with its own presentation', async () => {
  const h = await fixture();
  const result = await executeTurn({
    run: { ...h.run, forceResumeHandle: null, bypassPool: true, promptVariant: 'automation' },
    delivery: {
      kind: 'automation', outbox: h.outbox, journal: h.journal, turnId: 'turn', chatId: 'chat',
      actor: 'bot', emptyResult: 'empty', failureBody: () => 'failed',
      formatPost: (body, followUp) => `${body}${followUp ? '\n\nfollow up' : ''}`,
    },
  });
  expect(result.ok && result.handle.outcome?.kind).toBe('completed');
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'TRANSCRIPT-OK\n\nfollow up' }]);
  expect(h.journal.get('turn')?.outcome?.kind).toBe('completed');
});

it('observes a policy tool before settlement even when a normal terminal is already buffered', async () => {
  const h = await fixture({ events: [
    { type: 'tool_use', id: 'guarded', name: 'Bash', input: { command: 'synthetic forbidden operation' } },
    { type: 'done', terminationReason: 'normal' },
  ] });
  const result = await executeTurn({ run: { ...h.run, promptVariant: 'automation' }, delivery: automationDelivery(h),
    onToolUse: () => ({ type: 'policy-guard', code: 'auth-config' }),
  });
  expect(result.ok && result.handle.outcome).toEqual({
    kind: 'interrupted', reason: { type: 'policy-guard', code: 'auth-config' }, retriable: false, needsHuman: false,
  });
  expect(result.ok && result.state.terminal).toBe('interrupted');
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'failed: 策略拦截' }]);
  expect(h.agent.runs[0]?.stopped).toBe(true);
});

it('uses the settled outage overlap for the automation state, result and journal', async () => {
  let release!: () => void;
  let epoch = 0;
  const h = await fixture({
    events: [{ type: 'error', message: 'synthetic failure', terminationReason: 'failed' }],
    hold: new Promise<void>(resolve => { release = resolve; }),
    getLink: () => ({ outageEpoch: () => epoch, isDown: () => false }),
  });
  const pending = executeTurn({ run: { ...h.run, promptVariant: 'automation' }, delivery: automationDelivery(h) });
  await vi.waitFor(() => expect(h.agent.runs).toHaveLength(1));
  epoch++;
  release();
  const result = await pending;
  expect(result.ok && result.handle.outcome).toEqual({
    kind: 'failed', cause: 'transient-upstream', retriable: true, needsHuman: false,
  });
  expect(result.ok && result.state.terminal).toBe('error');
  expect(h.journal.get('turn')?.outcome).toEqual(result.ok && result.handle.outcome);
  expect(h.channel.sent.map(row => row.content)).toEqual([{ markdown: 'failed: 上游网络中断' }]);
});

it('reports an automation result before a rejected delivery can fail the caller', async () => {
  const h = await fixture();
  h.channel.sendErrors.send = { code: 230002, response: { status: 400, data: { code: 230002 } } };
  let resultStatus = 'failed';
  await expect(executeTurn({ run: h.run, delivery: { ...automationDelivery(h),
    onResult: (ok: boolean) => { resultStatus = ok ? 'ok' : 'failed'; },
  } })).rejects.toMatchObject({ code: 230002 });
  expect(resultStatus).toBe('ok');
  expect(h.journal.get('turn')?.outcome?.kind).toBe('completed');
});

it('stops a silent chat on its idle bound and delivers its continuation notice', async () => {
  const h = await fixture({ events: [], hold: new Promise(() => {}) });
  vi.useFakeTimers();
  const pending = executeTurn({ run: h.run, idleTimeoutMs: 60_000, delivery: { ...h.delivery, notice: {
    enabled: true, continuations: createContinuations({ journal: h.journal }), requireBotMention: false,
  } } });
  await vi.waitFor(() => expect(h.agent.runs).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await pending;
  expect(result.ok && result.state.terminal).toBe('idle_timeout');
  expect(result.ok && result.handle.outcome).toMatchObject({ kind: 'interrupted', reason: { type: 'bridge-idle-watchdog' } });
  expect(JSON.stringify(h.channel.sent.map(row => row.content))).toContain('空闲超时');
  expect(h.journal.get('turn')?.continuation?.status).toBe('offered');
});

it('keeps an explicit user stop distinct from an idle interruption', async () => {
  const h = await fixture({ events: [{ type: 'text', delta: 'Working' }], hold: new Promise(() => {}) });
  const pending = executeTurn({ run: h.run, delivery: h.delivery });
  await vi.waitFor(() => expect(h.activeRuns.snapshot()).toHaveLength(1));
  h.activeRuns.interrupt('chat', { type: 'user-stop' });
  const result = await pending;
  expect(result.ok && result.state.terminal).toBe('interrupted');
  expect(result.ok && result.handle.outcome).toMatchObject({ kind: 'interrupted', reason: { type: 'user-stop' } });
  expect(h.journal.get('turn')?.continuation).toBeUndefined();
});

it.each([
  ['timeout', 'runner_timeout', 'runner-timeout'],
  ['interrupted', 'interrupted', 'external-signal'],
] as const)('preserves a terminal %s reason through state and settlement', async (terminationReason, terminal, reason) => {
  const h = await fixture({ events: [{ type: 'done', terminationReason }] });
  const result = await executeTurn({ run: h.run, delivery: h.delivery });
  expect(result.ok && result.state.terminal).toBe(terminal);
  expect(result.ok && result.handle.outcome).toMatchObject({ kind: 'interrupted', reason: { type: reason } });
  expect(h.journal.get('turn')?.outcome).toEqual(result.ok && result.handle.outcome);
});

it('updates the returned handle activity time when a liveness event arrives', async () => {
  const h = await fixture();
  const originalRun = h.agent.run.bind(h.agent);
  h.agent.run = options => {
    const run = originalRun(options);
    return { ...run, runId: run.runId, waitForExit: run.waitForExit.bind(run), stop: run.stop.bind(run),
      events: { async *[Symbol.asyncIterator]() {
        vi.setSystemTime(new Date('2026-10-27T13:00:01Z'));
        yield { type: 'liveness' as const };
      } },
    };
  };
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T13:00:00Z'));
  const result = await executeTurn({ run: h.run, delivery: h.delivery });
  expect(result.ok && result.handle.lastEventAt).toBe(Date.parse('2026-10-27T13:00:01Z'));
});

function automationDelivery(h: Awaited<ReturnType<typeof fixture>>) {
  return {
    kind: 'automation' as const, outbox: h.outbox, journal: h.journal, turnId: 'turn', chatId: 'chat',
    actor: 'bot', emptyResult: 'empty', failureBody: (outcome: import('../../../src/bot/run-outcome').RunOutcome) => `failed: ${describeRunOutcome(outcome)}`,
    formatPost: (body: string, followUp: boolean) => `${body}${followUp ? '\n\nfollow up' : ''}`,
  };
}

async function fixture(options: {
  events?: readonly AgentEvent[];
  hold?: Promise<void>;
  getLink?: () => { outageEpoch(): number; isDown(): boolean };
} = {}) {
  const tmp = await createTmpProfile('turn-');
  const profileConfig = createDefaultProfileConfig({ agentKind: 'grok', accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } } });
  profileConfig.agentKind = 'grok';
  profileConfig.workspaces.default = tmp.workspace;
  const agent = new FakeAgentAdapter({ id: 'grok', events: options.events ?? replay(transcriptCase('grok', 'answer-only')), hold: options.hold });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns, getLink: options.getLink,
    stderrSignatures: variant => turnStderrSignatures('grok', variant) });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const journal = new TurnJournal(join(tmp.profile, 'turns.json'));
  await journal.load();
  journal.enqueue({ turnId: 'turn', scope: 'chat', chatId: 'chat', messageIds: ['parent'], senderId: 'user', initiatorId: 'user', status: 'queued' });
  const channel = createRecordingLarkChannel();
  const outbox = new Outbox({ channel: channel as unknown as LarkChannel, journal, botAppId: 'cli_test', liveSweep: false });
  cleanups.push(async () => { outbox.stop(); await journal.flush(); await sessions.flush(); await workspaces.flush(); await tmp.cleanup(); });
  return {
    agent, journal, channel, outbox, activeRuns,
    run: {
      scopeId: 'chat', scope: { source: 'im' as const, chatId: 'chat', actorId: 'user' },
      prompt: 'Answer OK', attachments: [], access: { ok: true as const, reason: 'allowed-user' as const },
      capability: capabilityForProfile(profileConfig), profileConfig, sessions, workspaces, executor, now: Date.now(),
    },
    delivery: {
      kind: 'chat' as const, outbox, channel: channel as unknown as LarkChannel, journal, turnId: 'turn',
      chatId: 'chat', sendOpts: { replyTo: 'parent' }, replyMode: 'text' as const,
      filterState: (state: import('../../../src/card/run-state').RunState) => state,
      outboundTimeoutMs: 1000,
    },
  };
}
