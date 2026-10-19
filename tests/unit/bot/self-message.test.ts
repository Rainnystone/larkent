import { describe, expect, it } from 'vitest';
import {
  CliSelfSendTracker,
  OutboundMessageIds,
  automationUnavailableForSender,
  isSelfSender,
  noteInboundSkipSelf,
  outboundMessageId,
  senderTypeFromMessage,
} from '../../../src/bot/self-message';
import { shouldSkipFinalReply, seedRunState, reduce } from '../../../src/card/run-state';

const CHAT = 'oc_trigger';
const BOT_OPEN = 'ou_bot';
const BOT_APP = 'cli_app';

describe('automationUnavailableForSender', () => {
  it('treats user as available, app and bot as requiring a human, and missing as distinct', () => {
    expect(automationUnavailableForSender({ raw: { sender: { sender_type: 'user' } } })).toBeUndefined();
    expect(automationUnavailableForSender({ senderType: 'user' })).toBeUndefined();
    expect(automationUnavailableForSender({ raw: { sender: { sender_type: 'app' } } }))
      .toBe('automation-requires-human');
    expect(automationUnavailableForSender({ senderType: 'bot' })).toBe('automation-requires-human');
    expect(automationUnavailableForSender({ raw: { sender: { sender_type: 'system' } } }))
      .toBe('automation-requires-human');
    expect(automationUnavailableForSender({})).toBe('automation-sender-type-missing');
    expect(automationUnavailableForSender({ raw: {} })).toBe('automation-sender-type-missing');
    expect(automationUnavailableForSender({ raw: { sender: { sender_type: '' } } }))
      .toBe('automation-sender-type-missing');
    expect(automationUnavailableForSender({ senderType: '' })).toBe('automation-sender-type-missing');
  });

  it('prefers the raw sender_type over a conflicting first-class field', () => {
    expect(senderTypeFromMessage({
      raw: { sender: { sender_type: 'user' } },
      senderType: 'app',
    })).toBe('user');
  });
});

describe('isSelfSender (backfill skip-self)', () => {
  it('matches the bot open id, the bot app id, or a p2p app sender', () => {
    expect(isSelfSender({
      senderId: BOT_OPEN,
      chatType: 'group',
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
    })).toBe(true);
    expect(isSelfSender({
      senderId: BOT_APP,
      senderType: 'app',
      chatType: 'group',
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
    })).toBe(true);
    expect(isSelfSender({
      senderId: 'cli_other',
      senderType: 'app',
      chatType: 'p2p',
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
    })).toBe(true);
  });

  it('keeps another app in a group when the sender is not this bot', () => {
    expect(isSelfSender({
      senderId: 'cli_other',
      senderType: 'app',
      chatType: 'group',
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
    })).toBe(false);
    expect(isSelfSender({
      senderId: 'ou_user',
      senderType: 'user',
      chatType: 'p2p',
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
    })).toBe(false);
  });
});

describe('inbound skip-self during a run', () => {
  it('marks the active scope only when skip-self matches and the id is not outbound', () => {
    const tracker = new CliSelfSendTracker();
    tracker.begin(CHAT);
    const outbound = new OutboundMessageIds();
    outbound.add('om_bridge');

    expect(noteInboundSkipSelf({
      messageId: 'om_bridge',
      chatId: CHAT,
      isSelf: true,
      outbound,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(false);

    expect(noteInboundSkipSelf({
      messageId: 'om_cli',
      chatId: CHAT,
      isSelf: true,
      outbound,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(true);

    expect(noteInboundSkipSelf({
      messageId: 'om_human',
      chatId: CHAT,
      isSelf: false,
      outbound,
      tracker,
    })).toBe(false);
  });

  it('consumes evidence so a later run in the same chat is not skipped', () => {
    const tracker = new CliSelfSendTracker();
    tracker.begin(CHAT);
    const outbound = new OutboundMessageIds();
    expect(noteInboundSkipSelf({
      messageId: 'om_cli',
      chatId: CHAT,
      isSelf: true,
      outbound,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(true);
    expect(shouldSkipFinalReply(
      reduce(seedRunState({ currentChatId: CHAT }), { type: 'done', terminationReason: 'normal' }),
      CHAT,
    ) || tracker.has(CHAT)).toBe(true);

    tracker.consume(CHAT);
    tracker.begin(CHAT);
    expect(tracker.has(CHAT)).toBe(false);
    expect(shouldSkipFinalReply(
      reduce(seedRunState({ currentChatId: CHAT }), { type: 'done', terminationReason: 'normal' }),
      CHAT,
    )).toBe(false);
  });

  it('binds a CLI self-send to the active turn id', () => {
    const tracker = new CliSelfSendTracker();
    tracker.begin(CHAT, 'turn-b');
    const outbound = new OutboundMessageIds();
    expect(noteInboundSkipSelf({
      messageId: 'om_cli',
      chatId: CHAT,
      isSelf: true,
      outbound,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(true);
    expect(tracker.turnIdFor(CHAT)).toBe('turn-b');
  });

  it('does not suppress a sibling topic thread', () => {
    const tracker = new CliSelfSendTracker();
    const threadA = `${CHAT}:omt_a`;
    const threadB = `${CHAT}:omt_b`;
    tracker.begin(threadA);
    tracker.begin(threadB);
    const outbound = new OutboundMessageIds();
    expect(noteInboundSkipSelf({
      messageId: 'om_cli_a',
      chatId: CHAT,
      threadId: 'omt_a',
      isSelf: true,
      outbound,
      tracker,
    })).toBe(true);
    expect(tracker.has(threadA)).toBe(true);
    expect(tracker.has(threadB)).toBe(false);
  });

  it('does not invent a skip when tool events were lost but no self-sent inbound arrived', () => {
    const state = reduce(seedRunState({ currentChatId: CHAT }), {
      type: 'done',
      terminationReason: 'normal',
    });
    expect(state.directImSentChatIds.size).toBe(0);
    expect(shouldSkipFinalReply(state, CHAT)).toBe(false);
    expect(shouldSkipFinalReply(state, CHAT, new Set([CHAT]))).toBe(true);
  });
});

describe('outboundMessageId', () => {
  it('reads messageId or message_id from a send receipt', () => {
    expect(outboundMessageId({ messageId: 'om_a' })).toBe('om_a');
    expect(outboundMessageId({ message_id: 'om_b' })).toBe('om_b');
    expect(outboundMessageId({})).toBeUndefined();
  });
});
