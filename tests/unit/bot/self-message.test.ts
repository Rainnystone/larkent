import { describe, expect, it } from 'vitest';
import {
  CliSelfSendTracker,
  OutboundMessageIds,
  isSelfSender,
  noteInboundSkipSelf,
  outboundMessageId,
} from '../../../src/bot/self-message';
import { shouldSkipFinalReply, seedRunState, reduce } from '../../../src/card/run-state';

const CHAT = 'oc_trigger';
const BOT_OPEN = 'ou_bot';
const BOT_APP = 'cli_app';

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
  it('marks the chat only when skip-self matches, the run is live, and the id is not outbound', () => {
    const tracker = new CliSelfSendTracker();
    const outbound = new OutboundMessageIds();
    outbound.add('om_bridge');

    expect(noteInboundSkipSelf({
      messageId: 'om_bridge',
      chatId: CHAT,
      isSelf: true,
      outbound,
      runActive: true,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(false);

    expect(noteInboundSkipSelf({
      messageId: 'om_cli',
      chatId: CHAT,
      isSelf: true,
      outbound,
      runActive: true,
      tracker,
    })).toBe(true);
    expect(tracker.has(CHAT)).toBe(true);

    expect(noteInboundSkipSelf({
      messageId: 'om_human',
      chatId: CHAT,
      isSelf: false,
      outbound,
      runActive: true,
      tracker,
    })).toBe(false);
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
