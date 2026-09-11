import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt final-reply ownership', () => {
  it('tells every agent the bridge posts the final answer to the triggering chat', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('最终回答发到触发会话');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('bridge_context.chat_id');
  });

  it('forbids IM-send to the current chat as a way of answering', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('+messages-send');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('+messages-reply');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('send-card');
  });

  it('allows sending to other chats or when the user explicitly asks for a lark-cli send', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('向其他 chat 发送');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求你执行一次 lark-cli 发送');
  });

  it('keeps the final-reply rule free of profile, bot, host, and agent-kind names', () => {
    const match = BRIDGE_SYSTEM_PROMPT.match(/## 最终回复\n\n([\s\S]*?)(\n## |$)/);
    expect(match?.[1]).toEqual(expect.any(String));
    const body = match?.[1] ?? '';
    expect(body).not.toMatch(/Grok Bot|grokbot|larkent-for-grokbot|agentKind/i);
    expect(body).not.toMatch(/\b(?:claude|codex|kimi|grok|cursor|antigravity)\b/i);
  });
});

describe('bridge system prompt bot collaboration rules', () => {
  it('states that bots only receive messages via a real structured mention', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只有被真实 @');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('收不到');
  });

  it('scopes the mention requirement to bots, not human users', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('人类用户');
  });

  it('tells the agent not to mention other bots by default to avoid loops', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('默认不要 @ 其他 bot');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('死循环');
  });

  it('allows mentioning a bot when the user explicitly asks for a handoff', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求');
  });

  it('points self-identification at the bridge_context botOpenId field', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('botOpenId');
  });

  it('documents the senderType and mentions context fields', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('senderType');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mentions');
  });

  it('tells the agent not to mimic the batch sender annotation format', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('[名字 (user|bot)]');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要模仿');
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('returns the base prompt unchanged when no identity is available', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a concrete identity line with open_id and name', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: '助手' });
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ou_bot_self');
    expect(prompt).toContain('助手');
  });

  it('appends the identity line even when the bot name is missing', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
  });
});

describe('prefixBridgeSystemPrompt', () => {
  it('prefixes the identity-aware system prompt before the user message', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', { openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
    expect(prompt.indexOf('ou_bot_self')).toBeLessThan(prompt.indexOf('## user_message'));
    expect(prompt.endsWith('hello world')).toBe(true);
  });

  it('keeps working without an identity', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', undefined);
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith('hello world')).toBe(true);
  });
});
