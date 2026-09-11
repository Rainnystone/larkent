import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { translateEvent as translateClaude } from '../../../src/agent/claude/stream-json.js';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl.js';
import { CursorJsonlTranslator } from '../../../src/agent/cursor/jsonl.js';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl.js';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/jsonl.js';
import { AGENT_KINDS, type AgentKind } from '../../../src/agent/registry.js';
import { OUTBOUND_SKIP_CLI_SENT_METRIC } from '../../../src/card/direct-im-send.js';
import {
  reduce,
  seedRunState,
  shouldSkipFinalReply,
  type RunState,
} from '../../../src/card/run-state.js';

const CHAT = 'oc_trigger';
const OTHER = 'oc_elsewhere';
const USER = 'ou_dm_peer';
const BATCH_MSG = 'om_batch_1';
const ANSWER = 'PINNED_ANSWER';

function fold(events: readonly AgentEvent[], chatId = CHAT, batchMessageIds = [BATCH_MSG]): RunState {
  return events.reduce(
    (state, evt) => reduce(state, evt),
    seedRunState({ currentChatId: chatId, batchMessageIds }),
  );
}

function bashSend(command: string): AgentEvent {
  return { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } };
}

function bashResult(output: string, isError = false): AgentEvent {
  return { type: 'tool_result', id: 'tool-1', output, isError };
}

function done(reason: AgentEvent extends { type: 'done'; terminationReason: infer R } ? R : never = 'normal'): AgentEvent {
  return { type: 'done', terminationReason: reason };
}

describe('RunState.directImSentChatIds', () => {
  it.each([
    ['+messages-send', `lark-cli im +messages-send --chat-id ${CHAT} --text hi`],
    ['+messages-reply', `lark-cli im +messages-reply --chat-id ${CHAT} --message-id ${BATCH_MSG} --text hi`],
    ['send-card', `lark-cli im send-card --chat-id ${CHAT} --card '{}'`],
    ['equals form', `lark-cli im +messages-send --chat-id=${CHAT} --text hi`],
    ['quoted chat id', `lark-cli im +messages-send --chat-id "${CHAT}" --text hi`],
    ['user open id', `lark-cli im +messages-send --chat-id ${USER} --text hi`],
    ['argv array', { command: ['lark-cli', 'im', '+messages-send', '--chat-id', CHAT, '--text', 'hi'] }],
  ] as const)('records a successful %s send', (_label, command) => {
    const input = typeof command === 'string' ? { command } : command;
    const state = fold([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input },
      bashResult('{"code":0,"data":{"message_id":"om_sent"}}'),
      { type: 'text', delta: ANSWER },
      done(),
    ]);
    const expected = typeof command === 'string' && command.includes(USER) ? USER : CHAT;
    expect([...state.directImSentChatIds]).toEqual([expected]);
    expect(shouldSkipFinalReply(state, expected)).toBe(true);
  });

  it('resolves --message-id to the current chat when the id is in the batch', () => {
    const state = fold([
      bashSend(`lark-cli im +messages-reply --message-id ${BATCH_MSG} --text hi`),
      bashResult('{"message_id":"om_sent"}'),
      done(),
    ]);
    expect([...state.directImSentChatIds]).toEqual([CHAT]);
  });

  it('records nothing for --message-id that is not in the batch', () => {
    const state = fold([
      bashSend('lark-cli im +messages-reply --message-id om_unrelated --text hi'),
      bashResult('{"message_id":"om_sent"}'),
      done(),
    ]);
    expect([...state.directImSentChatIds]).toEqual([]);
  });

  it('records a send to another chat without treating it as the trigger', () => {
    const state = fold([
      bashSend(`lark-cli im +messages-send --chat-id ${OTHER} --text hi`),
      bashResult(''),
      { type: 'text', delta: ANSWER },
      done(),
    ]);
    expect([...state.directImSentChatIds]).toEqual([OTHER]);
    expect(shouldSkipFinalReply(state, CHAT)).toBe(false);
    expect(shouldSkipFinalReply(state, OTHER)).toBe(true);
  });

  it.each([
    ['isError', bashResult('{"code":0}', true)],
    ['json error code', bashResult('{"code":99991663,"msg":"denied"}')],
    ['json error field', bashResult('{"error":"boom"}')],
    ['ok false', bashResult('{"ok":false}')],
  ] as const)('records nothing when the tool_result is unsuccessful (%s)', (_label, result) => {
    const state = fold([
      bashSend(`lark-cli im +messages-send --chat-id ${CHAT} --text hi`),
      result,
      { type: 'text', delta: ANSWER },
      done(),
    ]);
    expect([...state.directImSentChatIds]).toEqual([]);
    expect(shouldSkipFinalReply(state, CHAT)).toBe(false);
  });

  it.each([
    ['missing verb', 'lark-cli im +messages-list --chat-id oc_trigger'],
    ['different cli', 'feishu-cli im +messages-send --chat-id oc_trigger'],
    ['no target', 'lark-cli im +messages-send --text hi'],
    ['malformed', 'not a command'],
  ])('records nothing for a malformed send (%s)', (_label, command) => {
    const state = fold([
      bashSend(command),
      bashResult('{"code":0}'),
      done(),
    ]);
    expect([...state.directImSentChatIds]).toEqual([]);
  });

  it('does not persist the set — it starts empty on a fresh run', () => {
    const first = fold([
      bashSend(`lark-cli im +messages-send --chat-id ${CHAT} --text hi`),
      bashResult('ok'),
      done(),
    ]);
    expect(first.directImSentChatIds.size).toBe(1);
    expect(seedRunState({ currentChatId: CHAT, batchMessageIds: [BATCH_MSG] }).directImSentChatIds.size).toBe(
      0,
    );
  });

  it.each(['error', 'interrupted', 'idle_timeout'] as const)(
    'does not skip the final reply when terminal is %s',
    (terminal) => {
      const recorded = fold([
        bashSend(`lark-cli im +messages-send --chat-id ${CHAT} --text hi`),
        bashResult('{"code":0}'),
      ]);
      const ended =
        terminal === 'error'
          ? reduce(recorded, { type: 'error', message: 'failed', terminationReason: 'failed' })
          : terminal === 'interrupted'
            ? reduce(recorded, { type: 'done', terminationReason: 'interrupted' })
            : reduce(recorded, { type: 'done', terminationReason: 'timeout' });
      expect([...ended.directImSentChatIds]).toEqual([CHAT]);
      expect(ended.terminal).toBe(terminal);
      expect(shouldSkipFinalReply(ended, CHAT)).toBe(false);
    },
  );
});

describe('scripted JSONL streams populate the shared reducer for every agent kind', () => {
  it.each(AGENT_KINDS)('%s successful CLI send records the chat; failed send does not', (kind) => {
    const ok = fold(eventsFromKindJsonl(kind, true));
    expect([...ok.directImSentChatIds]).toEqual([CHAT]);
    expect(shouldSkipFinalReply(ok, CHAT)).toBe(true);

    const failed = fold(eventsFromKindJsonl(kind, false));
    expect([...failed.directImSentChatIds]).toEqual([]);
    expect(shouldSkipFinalReply(failed, CHAT)).toBe(false);
  });
});

describe('rejected approach', () => {
  it('documents that a post-run history check by bot identity is not implemented', () => {
    const source = readFileSync(join(process.cwd(), 'src/card/direct-im-send.ts'), 'utf8');
    expect(source).toMatch(/post-run history check/i);
    expect(source).toMatch(/bot identity/i);
    expect(source).not.toMatch(/history\.list|im\.v1\.message\.list/);
    expect(OUTBOUND_SKIP_CLI_SENT_METRIC).toBe('outbound_skip_cli_sent');
  });
});

function eventsFromKindJsonl(kind: AgentKind, success: boolean): AgentEvent[] {
  const command = `lark-cli im +messages-send --chat-id ${CHAT} --text hi`;
  const output = success ? '{"code":0,"data":{"message_id":"om_sent"}}' : '{"code":99991663,"msg":"denied"}';
  switch (kind) {
    case 'claude':
      return [
        ...translateClaude({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }],
          },
        }),
        ...translateClaude({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: output, is_error: !success }],
          },
        }),
        ...translateClaude({
          type: 'assistant',
          message: { content: [{ type: 'text', text: ANSWER }] },
        }),
        ...translateClaude({ type: 'result', session_id: 'sess' }),
      ];
    case 'codex': {
      const t = new CodexJsonlTranslator();
      return [
        ...t.translate({ type: 'thread.started', thread_id: 'thread-1' }),
        ...t.translate({
          type: 'item.started',
          item: { id: 'tool-1', type: 'command_execution', command },
        }),
        ...t.translate({
          type: 'item.completed',
          item: {
            id: 'tool-1',
            type: 'command_execution',
            output,
            exit_code: success ? 0 : 1,
          },
        }),
        ...t.translate({ type: 'agent_message', message: ANSWER }),
        ...t.translate({ type: 'turn.completed' }),
      ];
    }
    case 'kimi': {
      const t = new KimiJsonlTranslator();
      return [
        ...t.translate({
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: 'tool-1',
              function: { name: 'Bash', arguments: JSON.stringify({ command }) },
            },
          ],
        }),
        ...t.translate({ role: 'tool', tool_call_id: 'tool-1', content: output }),
        ...t.translate({ role: 'assistant', content: ANSWER }),
        ...t.finish('normal'),
      ];
    }
    case 'grok': {
      const t = new GrokJsonlTranslator();
      return [
        ...t.translate({
          type: 'tool_call',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          status: 'in_progress',
          rawInput: { command },
        }),
        ...t.translate({
          type: 'tool_call_update',
          toolCallId: 'tool-1',
          status: success ? 'completed' : 'failed',
          rawOutput: JSON.parse(output) as unknown,
        }),
        ...t.translate({ type: 'text', data: ANSWER }),
        ...t.translate({ type: 'end', sessionId: 'sess', stopReason: 'end_turn' }),
      ];
    }
    case 'cursor': {
      const t = new CursorJsonlTranslator();
      return [
        ...t.translate({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'tool-1',
          tool_call: { function: { name: 'Bash', arguments: JSON.stringify({ command }) } },
        }),
        ...t.translate({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'tool-1',
          tool_call: {
            function: {
              name: 'Bash',
              arguments: JSON.stringify({ command }),
              result: success
                ? { success: JSON.parse(output) as unknown }
                : { error: 'denied' },
            },
          },
        }),
        ...t.translate({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
        }),
        ...t.translate({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: ANSWER,
          session_id: 'sess',
        }),
      ];
    }
    case 'antigravity':
      // Antigravity's stream-json translator does not yet emit tool events.
      // The shared reducer still sees the same AgentEvent shape every kind
      // produces after translation, so the scripted stream is that shape.
      return [
        bashSend(command),
        bashResult(output, !success),
        { type: 'final_text', content: ANSWER },
        done(),
      ];
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}
