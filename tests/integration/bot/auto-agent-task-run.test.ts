import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATCH_UP_PROMPT_MARKER } from '../../../src/automations/agent-run';
import { fireTurnId } from '../../../src/automations/delivery';
import {
  formatFireKey,
  type Schedule,
} from '../../../src/automations/schedule';
import { automationRunScope } from '../../../src/bot/scope';
import { AutomationsStore } from '../../../src/automations/store';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { log } from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
const HOUR = 60 * 60_000;
const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);
const HOURLY_END = t0 + 365 * 24 * HOUR;
const hourly: Extract<Schedule, { kind: 'interval' }> = {
  kind: 'interval',
  timezone: 'UTC',
  everyMs: HOUR,
  startAt: t0,
  endAt: HOURLY_END,
};
const FOOTER = '在本消息话题里追问';
const GROK_ANSWER = 'AG4 完成，群数=1';
const TASK = '汇总昨天的 issue';
const FIRE_ONE = 'FIRE_ONE_RESULT';
const FIRE_TWO = 'FIRE_TWO_RESULT';
const HUMAN = 'HUMAN_CHAT_ANSWER';
const FOLLOW = 'FOLLOW_UP_ANSWER';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation agent-task run', { timeout: 20_000 }, () => {
  it('posts a final-answer result from final_text when the run has no text deltas', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      agentKind: 'grok',
      events: [grokFinalRun(GROK_ANSWER, 'sess-grok')],
    });

    await waitFor(() => resultBodies(h.channel).length === 1);
    const post = resultBodies(h.channel)[0] ?? '';
    expect(post).toBe(`${GROK_ANSWER}\n\n${FOOTER}`);
    expect(post.split(GROK_ANSWER)).toHaveLength(2);
  });

  it('uses the same final-answer body for a text reply and an automation result', async () => {
    const h = await harness({
      nowMs: t0,
      seed: agentInput({ nextFireAt: t0 + HOUR }),
      agentKind: 'grok',
      messageReply: 'text',
      cotMessages: 'off',
      events: [
        grokFinalRun(GROK_ANSWER, 'sess-human'),
        grokFinalRun(GROK_ANSWER, 'sess-fire'),
      ],
    });

    await h.channel.handlers.message?.(mention('om_human', '请汇总群数'));
    await waitFor(() => bodies(h.channel).some((body) => body.includes(GROK_ANSWER) && !body.includes(FOOTER)));

    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(() => resultBodies(h.channel).length === 1);

    const human = bodies(h.channel).find((body) => body.includes(GROK_ANSWER) && !body.includes(FOOTER));
    expect(resultBodies(h.channel)).toEqual([`${human}\n\n${FOOTER}`]);
  });

  it('keeps a partial-output warning with the final answer on both reply paths', async () => {
    const warning = '输出不完整（打印超时），可稍后继续';
    const h = await harness({
      nowMs: t0,
      seed: agentInput({ nextFireAt: t0 + HOUR }),
      agentKind: 'antigravity',
      messageReply: 'text',
      cotMessages: 'off',
      stderr: 'print timeout after 30s returning partial output',
      events: [
        grokFinalRun(GROK_ANSWER, 'sess-human'),
        grokFinalRun(GROK_ANSWER, 'sess-fire'),
      ],
    });

    await h.channel.handlers.message?.(mention('om_human', '请汇总群数'));
    await waitFor(() => bodies(h.channel).some((body) => body.includes(warning) && !body.includes(FOOTER)));

    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(() => resultBodies(h.channel).some((body) => body.includes(warning)));

    const human = bodies(h.channel).find((body) => body.includes(warning) && !body.includes(FOOTER));
    expect(human).toBe(`${GROK_ANSWER}\n\n${warning}`);
    expect(resultBodies(h.channel)).toEqual([`${human}\n\n${FOOTER}`]);
  });

  it('keeps a final answer when stderr matches a failure signature', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      agentKind: 'grok',
      stderr: 'unauthorized: invalid API key',
      events: [grokFinalRun(GROK_ANSWER, 'sess-auth')],
    });
    await waitFor(() => resultBodies(h.channel).length === 1);
    expect(resultBodies(h.channel)).toEqual([`${GROK_ANSWER}\n\n${FOOTER}`]);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');
  });

  it('keeps a stream-deltas result as the text blocks', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [textRun(FIRE_ONE, 'sess-claude')],
    });
    await waitFor(() => resultBodies(h.channel).length === 1);
    expect(resultBodies(h.channel)).toEqual([`${FIRE_ONE}\n\n${FOOTER}`]);
  });

  it('puts the catch-up line between the final answer and the footer', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      linkDown: true,
      agentKind: 'grok',
      events: [grokFinalRun(GROK_ANSWER, 'sess-catch')],
    });
    await h.bridge.tickLink();
    h.setNow(t0 + 61_000);
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(() => resultBodies(h.channel).length === 1);
    expect(resultBodies(h.channel)).toEqual([
      `${GROK_ANSWER}\n\n（补跑，原定 12:00）\n\n${FOOTER}`,
    ]);
  });

  it('posts the empty-result line when Grok final text is only a control token', async () => {
    const translator = new GrokJsonlTranslator();
    const events = [
      { type: 'text', data: ' <|eos|>\n' },
      { type: 'end', sessionId: 'sess-eos', stopReason: 'end_turn' },
    ].flatMap((line) => translator.translate(line));
    const h = await harness({
      nowMs: t0,
      seed: true,
      agentKind: 'grok',
      events: [events],
    });
    await waitFor(() => resultBodies(h.channel).length === 1);
    const post = resultBodies(h.channel).join('\n');
    expect(post).not.toContain('<|eos|>');
    expect(resultBodies(h.channel)).toEqual([
      `任务已完成，agent 没有给出文字结果。\n\n${FOOTER}`,
    ]);
  });

  it('posts an explicit empty-result line instead of a footer-only post', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [[
        { type: 'system', resumeHandle: 'sess-empty' },
        {
          type: 'tool_use',
          id: 'tool-empty',
          name: 'Bash',
          input: { command: 'true' },
        },
        { type: 'tool_result', id: 'tool-empty', output: '', isError: false },
        { type: 'done', terminationReason: 'normal' },
      ]],
    });
    await waitFor(() => resultBodies(h.channel).length === 1);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');
    expect(resultBodies(h.channel)).toEqual([
      `任务已完成，agent 没有给出文字结果。\n\n${FOOTER}`,
    ]);
  });

  it('posts one result via Outbox with footer, no stream/CoT, status ok, and empty automations log', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [textRun(FIRE_ONE, 'sess-fire')],
    });

    await waitFor(() => resultBodies(h.channel).length === 1);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');

    expect(resultBodies(h.channel)).toEqual([`${FIRE_ONE}\n\n${FOOTER}`]);
    expect(outboxSends(h.channel)).toHaveLength(1);
    expect(replyToOf(outboxSends(h.channel)[0])).toBeUndefined();
    expect(h.channel.streams).toEqual([]);
    expect(reactions(h.channel)).toEqual([]);
    expect(continuationBodies(h.channel)).toEqual([]);
    expect(h.agent.runOptions[0]?.prompt).toContain('<bridge_context>');
    expect(h.agent.runOptions[0]?.prompt).toContain(`"chatId":"${CHAT}"`);
    expect(h.agent.runOptions[0]?.prompt).toContain(TASK);
    expect(h.agent.runOptions[0]).toMatchObject({
      resumeHandle: undefined,
    });
    expect(h.agent.runOptions[0]?.cwd).toBe(h.workspace);
    expect(await readStatus(h.statusPath)).toMatchObject({
      v: 1,
      bot: 'Pin Bot',
      items: [{
        id: 1,
        paused: false,
        nextFireAt: t0 + HOUR,
        lastFireAt: t0,
        lastStatus: 'ok',
        endAt: HOURLY_END,
        missed: 0,
      }],
    });
    expect((await readStatus(h.statusPath)).updatedAt).toBeGreaterThanOrEqual(t0);
    await expect(h.store.readLog()).resolves.toEqual([]);
  });

  it('lets a fire and a human run proceed together and keeps automation content out of the group session', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      nowMs: t0,
      seed: agentInput({ nextFireAt: t0 + HOUR }),
      events: [
        [{ type: 'text', delta: HUMAN }],
        [{ type: 'text', delta: FIRE_ONE }],
      ],
      hold,
      messageReply: 'text',
      cotMessages: 'off',
    });

    await h.channel.handlers.message?.(mention('om_human', 'please answer the standup'));
    await waitFor(() => h.agent.runs.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('please answer the standup');
    expect(h.agent.runOptions[0]?.prompt).toContain('group_automations');
    expect(h.agent.runOptions[0]?.prompt).toContain(TASK);
    expect(h.agent.runOptions[0]?.prompt).not.toContain(FIRE_ONE);

    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(() => h.agent.runs.length === 2);
    expect(h.agent.runOptions[1]?.prompt).toContain(TASK);
    expect(h.agent.runOptions[1]?.prompt).toContain(`"chatId":"${CHAT}"`);
    expect(h.agent.runOptions[1]?.prompt).not.toContain('please answer the standup');

    release();
    await waitFor(() => resultBodies(h.channel).length === 1 && humanBodies(h.channel).length === 1);

    expect(resultBodies(h.channel)).toEqual([`${FIRE_ONE}\n\n${FOOTER}`]);
    expect(humanBodies(h.channel)).toEqual([HUMAN]);
    expect(humanBodies(h.channel)[0]).not.toContain(FIRE_ONE);
    expect(humanBodies(h.channel)[0]).not.toContain(TASK);
    expect(humanBodies(h.channel)[0]).not.toContain(FOOTER);
    expect(continuationBodies(h.channel)).toEqual([]);
  });

  it('starts a fire immediately when the process pool is full of human runs and still posts the result', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      nowMs: t0,
      seed: agentInput({ nextFireAt: t0 + HOUR }),
      events: [
        [{ type: 'text', delta: HUMAN }],
        [{ type: 'text', delta: FIRE_ONE }],
      ],
      hold,
      maxConcurrentRuns: 1,
      messageReply: 'text',
      cotMessages: 'off',
    });

    await h.channel.handlers.message?.(mention('om_human', 'please answer the standup'));
    await waitFor(() => h.agent.runs.length === 1);

    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(() => h.agent.runs.length === 2);

    expect(h.agent.runs).toHaveLength(2);
    expect(resultBodies(h.channel)).toEqual([]);

    release();
    await waitFor(() => resultBodies(h.channel).length === 1);
    expect(resultBodies(h.channel)).toEqual([`${FIRE_ONE}\n\n${FOOTER}`]);
    expect(continuationBodies(h.channel)).toEqual([]);
  });

  it('skips the next fire of an agent task while the previous run is unsettled', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [
        [{ type: 'system', resumeHandle: 'sess-a' }, { type: 'text', delta: FIRE_ONE }],
        [{ type: 'system', resumeHandle: 'sess-b' }, { type: 'text', delta: FIRE_TWO }],
      ],
      hold,
    });

    await waitFor(() => h.agent.runs.length === 1);
    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(async () => (await h.store.readLog()).some((entry) => entry.result === 'skipped'));

    expect(h.agent.runs).toHaveLength(1);
    expect(resultBodies(h.channel)).toEqual([]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        taskType: 'agent',
        scheduledAt: t0 + HOUR,
        result: 'skipped',
        skipReason: 'previous-run-unsettled',
      }),
    ]);
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({ lastStatus: 'running', lastFireAt: t0, missed: 0 })],
    });
    await waitFor(() => {
      const board = JSON.stringify(h.channel.sent) + JSON.stringify(h.channel.updatedCards);
      return board.includes('已跳过 原定 2026-01-02 13:00');
    });
    const board = JSON.stringify(h.channel.sent) + JSON.stringify(h.channel.updatedCards);
    expect(board).toContain('已跳过 原定 2026-01-02 13:00');
    expect(board).toContain('进行中');
    expect(board).not.toContain('\\"lastStatus\\"');

    release();
    await waitFor(() => resultBodies(h.channel).length === 1);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');
    expect(resultBodies(h.channel)).toEqual([`${FIRE_ONE}\n\n${FOOTER}`]);
    expect(h.agent.runs).toHaveLength(1);
    expect(continuationBodies(h.channel)).toEqual([]);
  });

  it('posts a plain failure notice with no 继续, and restart does not offer a Continuation', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await harness({
      nowMs: t0,
      seed: true,
      events: [[{ type: 'system', resumeHandle: 'sess-fire' }]],
      hold,
    });
    await waitFor(() => first.agent.runs.length === 1);
    await first.bridge.disconnect();
    release();

    const staged = first.journal.list().find((entry) => entry.turnId.startsWith('af:'));
    expect(staged?.reply?.markdown ?? '').toMatch(/已中断|进程退出|运行失败/);
    expect(staged?.reply?.markdown ?? '').not.toContain(FOOTER);
    expect(JSON.stringify(staged)).not.toContain('notice.continue');
    expect(continuationBodies(first.channel)).toEqual([]);

    const restarted = await harness({
      nowMs: t0,
      tmp: first.tmp,
      store: first.store,
      reuseCleanup: true,
      messageReply: 'text',
      cotMessages: 'off',
      events: [[
        { type: 'system', resumeHandle: 'sess-human' },
        { type: 'text', delta: 'NOT_THE_FIRE' },
        { type: 'done', terminationReason: 'normal' },
      ]],
    });
    await waitFor(() => bodies(restarted.channel).some((body) => /已中断|进程退出|运行失败/.test(body)));
    expect(bodies(restarted.channel).join('\n')).toMatch(/已中断|进程退出|运行失败/);
    expect(bodies(restarted.channel).join('\n')).not.toContain(FOOTER);
    expect(continuationBodies(restarted.channel)).toEqual([]);
    expect(JSON.stringify(restarted.channel.sent)).not.toContain('notice.continue');

    const rootId = resultPostId(restarted.journal);
    await restarted.channel.handlers.message?.(mention('om_recover', '继续', {
      threadId: rootId,
      rootId,
      parentId: rootId,
    }));
    await waitFor(() => restarted.agent.runs.length === 1);
    expect(restarted.agent.runOptions[0]?.resumeHandle).toBeUndefined();
    const follow = restarted.journal.list().find((entry) => entry.messageIds.includes('om_recover'));
    expect(follow?.scope.startsWith('auto:')).toBe(false);
    await waitFor(async () => (await readStatus(restarted.statusPath)).items[0]?.lastStatus === 'failed');
    expect(await readStatus(restarted.statusPath)).toMatchObject({
      items: [expect.objectContaining({ id: 1, lastFireAt: t0, lastStatus: 'failed', missed: 0 })],
    });
  });

  it('shows lastStatus running while the fire is in flight, then ok after the result post', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [[{ type: 'system', resumeHandle: 'sess-fire' }, { type: 'text', delta: FIRE_ONE }]],
      hold,
    });
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'running');
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({
        id: 1,
        lastFireAt: t0,
        lastStatus: 'running',
        nextFireAt: t0 + HOUR,
      })],
    });

    release();
    await waitFor(() => resultBodies(h.channel).length === 1);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({ lastStatus: 'ok', lastFireAt: t0 })],
    });
  });

  it.each(['group', 'topic'] as const)(
    'resumes the fire session from a thread reply under the result post (%s)',
    async (chatMode) => {
      const h = await harness({
        nowMs: t0,
        seed: true,
        chatMode,
        messageReply: 'text',
        cotMessages: 'off',
        events: [
          textRun(FIRE_ONE, 'sess-fire'),
          textRun(FOLLOW, 'sess-fire'),
        ],
      });
      await waitFor(() => resultBodies(h.channel).length === 1);
      const rootId = resultPostId(h.journal);
      expect(rootId).toMatch(/^om_/);

      await h.channel.handlers.message?.(mention('om_follow', '追问细节', {
        threadId: rootId,
        rootId,
        parentId: rootId,
      }));
      await waitFor(() => h.agent.runs.length === 2);

      expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-fire');
      expect(h.agent.runOptions[1]?.prompt).toContain('追问细节');
      await waitFor(() => bodies(h.channel).some((body) => body.includes(FOLLOW)));
      expect(continuationBodies(h.channel)).toEqual([]);
    },
  );

  it('catch-up posts once with 补跑, writes one log entry, and a later wake is silent', async () => {
    const h = await harness({
      nowMs: t0,
      seed: true,
      linkDown: true,
      events: [textRun(FIRE_ONE, 'sess-fire')],
    });
    await h.bridge.tickLink();
    expect(outboxSends(h.channel)).toEqual([]);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(false);

    h.setNow(t0 + 61_000);
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(() => resultBodies(h.channel).length === 1);

    expect(resultBodies(h.channel)).toEqual([
      `${FIRE_ONE}\n\n（补跑，原定 12:00）\n\n${FOOTER}`,
    ]);
    expect(h.agent.runOptions[0]?.prompt).toContain('补跑');
    expect(h.agent.runOptions[0]?.prompt).toContain('12:00');
    expect(h.agent.runOptions[0]?.prompt).toContain(TASK);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        taskType: 'agent',
        scheduledAt: t0,
        triggerSource: 'startup',
        result: 'catch-up',
      }),
    ]);
    await waitFor(async () => (await readStatus(h.statusPath)).items[0]?.lastStatus === 'ok');
    expect(await readStatus(h.statusPath)).toMatchObject({
      v: 1,
      items: [expect.objectContaining({
        id: 1,
        lastFireAt: t0,
        lastStatus: 'ok',
        missed: 0,
      })],
    });

    const sentAfterCatchUp = outboxSends(h.channel).length;
    await h.bridge.wakeAutomation(formatFireKey(1, t0));
    await yieldIO();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(outboxSends(h.channel)).toHaveLength(sentAfterCatchUp);
    expect(resultBodies(h.channel)).toHaveLength(1);
    await expect(h.store.readLog()).resolves.toHaveLength(1);
  });

  it('catch-up failure notice still says 补跑, writes one log entry, and lastStatus is failed', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await harness({
      nowMs: t0,
      seed: true,
      linkDown: true,
      events: [[{ type: 'system', resumeHandle: 'sess-fire' }]],
      hold,
    });
    await first.bridge.tickLink();
    first.setNow(t0 + 61_000);
    first.channel.connectionState = 'connected';
    await first.bridge.tickLink();
    await waitFor(() => first.agent.runs.length === 1);
    await waitFor(async () => (await readStatus(first.statusPath)).items[0]?.lastStatus === 'running');

    await first.bridge.disconnect();
    release();

    const staged = first.journal.list().find((entry) => entry.turnId.startsWith('af:'));
    expect(staged?.reply?.markdown ?? '').toMatch(/已中断|进程退出|运行失败/);
    expect(staged?.reply?.markdown ?? '').toContain('（补跑，原定 12:00）');
    expect(staged?.reply?.markdown ?? '').not.toContain(FOOTER);

    const restarted = await harness({
      nowMs: t0 + 61_000,
      tmp: first.tmp,
      store: first.store,
      reuseCleanup: true,
      events: [],
    });
    await waitFor(() => bodies(restarted.channel).some((body) => body.includes('（补跑，原定 12:00）')));
    expect(bodies(restarted.channel).join('\n')).toContain('（补跑，原定 12:00）');
    expect(bodies(restarted.channel).join('\n')).toMatch(/已中断|进程退出|运行失败/);
    expect(bodies(restarted.channel).join('\n')).not.toContain(FOOTER);
    expect(continuationBodies(restarted.channel)).toEqual([]);
    expect(await restarted.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        taskType: 'agent',
        scheduledAt: t0,
        triggerSource: 'startup',
        result: 'catch-up',
      }),
    ]);
    await waitFor(async () => (await readStatus(restarted.statusPath)).items[0]?.lastStatus === 'failed');
  });

  it('dates a recovered catch-up interrupt against recovery time', async () => {
    const recoveryNow = t0 + 24 * HOUR + 61_000;
    const h = await harness({
      nowMs: recoveryNow,
      seed: agentInput({ paused: true, nextFireAt: t0 + 48 * HOUR }),
      events: [],
      beforeStart: async ({ journal }) => {
        journal.enqueue({
          turnId: fireTurnId(formatFireKey(1, t0)),
          scope: automationRunScope(1, t0),
          chatId: CHAT,
          messageIds: [],
          senderId: 'ou_bot',
          initiatorId: 'ou_bot',
          initiatorType: 'bot',
          status: 'running',
          userInput: `${CATCH_UP_PROMPT_MARKER}12:00。请按原定任务执行。\n\n${TASK}`,
        });
        await journal.flush();
      },
    });
    await waitFor(() => bodies(h.channel).some((body) => body.includes('原定')));
    const notice = bodies(h.channel).filter((body) => body.includes('原定')).join('\n');
    expect(notice).toContain('原定 01-02 12:00');
    expect(notice).not.toContain(FOOTER);
  });

  it('skips the bridge result post when the agent already IM-sent to the group', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [scriptedSend(CHAT, FIRE_ONE)],
    });
    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'skip-cli-already-sent'),
    );
    expect(resultBodies(h.channel)).toEqual([]);
    expect(continuationBodies(h.channel)).toEqual([]);
    info.mockRestore();
  });
});

type Recording = ReturnType<typeof createRecordingLarkChannel>;

async function harness(opts: {
  nowMs: number;
  seed?: boolean | ReturnType<typeof agentInput>;
  linkDown?: boolean;
  events?: FakeAgentEvents;
  hold?: Promise<void>;
  chatMode?: 'group' | 'topic';
  maxConcurrentRuns?: number;
  messageReply?: 'card' | 'text';
  cotMessages?: 'off' | 'detailed';
  agentKind?: 'claude' | 'grok' | 'antigravity';
  stderr?: string;
  tmp?: Awaited<ReturnType<typeof createTmpProfile>>;
  store?: AutomationsStore;
  reuseCleanup?: boolean;
  beforeStart?: (ctx: { journal: TurnJournal; store: AutomationsStore }) => Promise<void>;
} = { nowMs: t0 }) {
  const tmp = opts.tmp ?? await createTmpProfile('auto-agent-');
  let nowMs = opts.nowMs;
  const now = () => nowMs;
  const store = opts.store ?? new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  if (!opts.store) await store.load();
  const seeds = opts.seed === true
    ? [agentInput()]
    : opts.seed
      ? [opts.seed]
      : [];
  for (const item of seeds) await store.create({ ...item, cwd: item.cwd ?? tmp.workspace });

  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  if (opts.beforeStart) await opts.beforeStart({ journal, store });
  const cfg = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: opts.messageReply ?? 'card',
      messageReplyMigrated: true,
      cotMessages: opts.cotMessages ?? 'detailed',
      showToolCalls: true,
      ...(opts.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: opts.maxConcurrentRuns }
        : {}),
    },
  });
  cfg.automations = { enabled: true, agentTasks: true, timezone: 'UTC' };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: opts.events ?? [],
    ...(opts.hold ? { hold: opts.hold } : {}),
    ...(opts.stderr ? { stderr: opts.stderr } : {}),
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: opts.chatMode ?? 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  if (opts.linkDown) channel.connectionState = 'reconnecting';
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
    journal,
    now,
    probe: async () => true,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-auto-agent',
    },
  });
  const cleanup = async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    if (!opts.reuseCleanup) await tmp.cleanup();
  };
  cleanups.push(cleanup);
  return {
    channel,
    store,
    journal,
    bridge,
    agent,
    tmp,
    workspace: await realpath(tmp.workspace),
    statusPath: join(tmp.profile, 'automations-status.json'),
    setNow(next: number) {
      nowMs = next;
    },
  };
}

function agentInput(overrides: Partial<Parameters<AutomationsStore['create']>[0]> = {}) {
  return {
    taskType: 'agent' as const,
    schedule: hourly,
    timezone: 'UTC',
    startAt: t0,
    endAt: HOURLY_END,
    nextFireAt: t0,
    chatId: CHAT,
    createdBy: USER,
    name: 'issue 汇总',
    taskText: TASK,
    ...overrides,
  };
}

function grokFinalRun(answer: string, resumeHandle: string): AgentEvent[] {
  return [
    { type: 'system', resumeHandle },
    {
      type: 'tool_use',
      id: 'tool-ag4',
      name: 'Bash',
      input: { command: 'printf group-count' },
    },
    {
      type: 'tool_result',
      id: 'tool-ag4',
      output: '1',
      isError: false,
    },
    { type: 'final_text', content: answer },
    { type: 'done', terminationReason: 'normal' },
  ];
}

function textRun(text: string, resumeHandle: string): AgentEvent[] {
  return [
    { type: 'system', resumeHandle },
    { type: 'text', delta: text },
    { type: 'done', terminationReason: 'normal' },
  ];
}

function scriptedSend(chatId: string, answer: string) {
  return [
    {
      type: 'tool_use' as const,
      id: 'tool-1',
      name: 'Bash',
      input: { command: `lark-cli im +messages-send --chat-id ${chatId} --text already delivered` },
    },
    {
      type: 'tool_result' as const,
      id: 'tool-1',
      output: '{"code":0,"data":{"message_id":"om_sent"}}',
      isError: false,
    },
    { type: 'text' as const, delta: answer },
    { type: 'final_text' as const, content: answer },
    { type: 'done' as const, terminationReason: 'normal' as const },
  ];
}

function mention(
  messageId: string,
  content: string,
  extra: { threadId?: string; rootId?: string; parentId?: string } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Pin Bot', isBot: true }],
    createTime: Date.now(),
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
    ...(extra.rootId ? { rootId: extra.rootId } : {}),
    ...(extra.parentId ? { parentId: extra.parentId, replyToMessageId: extra.parentId } : {}),
  } as unknown as NormalizedMessage;
}

function bodies(channel: Recording): string[] {
  return channel.sent.map((row) => {
    const content = row.content as { text?: string; markdown?: string };
    if (typeof content?.text === 'string') return content.text;
    if (typeof content?.markdown === 'string') return content.markdown;
    return JSON.stringify(row.content);
  });
}

function isBoardSend(row: Recording['sent'][number]): boolean {
  return JSON.stringify(row.content).includes('本群自动化');
}

function outboxSends(channel: Recording): Recording['sent'] {
  return channel.sent.filter((row) => !isBoardSend(row));
}

function resultBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.includes(FOOTER));
}

function humanBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.includes(HUMAN) && !body.includes(FOOTER));
}

function continuationBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.includes('继续') || body.includes('notice.continue'));
}

function replyToOf(row: Recording['sent'][number] | undefined): string | undefined {
  const options = row?.options as { replyTo?: string } | undefined;
  const replyTo = options?.replyTo;
  return typeof replyTo === 'string' && replyTo ? replyTo : undefined;
}

function reactions(channel: Recording): Recording['callLog'] {
  return channel.callLog.filter((row) => row.op === 'reaction.create');
}

function resultPostId(journal: TurnJournal): string {
  const id = journal.list().find((entry) => (
    entry.turnId.startsWith('af:') && typeof entry.reply?.messageId === 'string'
  ))?.reply?.messageId;
  if (!id) throw new Error('expected agent fire result post message id');
  return id;
}

async function readStatus(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    v: number;
    bot: string;
    updatedAt: number;
    items: Array<{
      id: number;
      paused: boolean;
      nextFireAt: number;
      lastFireAt: number;
      lastStatus: string;
      endAt: number;
      missed: number;
    }>;
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected automation agent-task transition was not observed');
}
