import { describe, expect, it } from 'vitest';
import { filterHostSleepFinals } from '../../e2e/test-bridge/scenarios/host-sleep-cli-self-send';

const TOKEN = 'e2e-sleep-abc';
const SENT_AT = 1_760_000_000_000;

describe('filterHostSleepFinals', () => {
  it('excludes the tester trigger by message id and older history', () => {
    const finals = filterHostSleepFinals(
      [
        { messageId: 'om_old', text: `please answer ${TOKEN}`, createTime: String(SENT_AT - 60_000) },
        { messageId: 'om_trigger', text: `please answer ${TOKEN}`, createTime: String(SENT_AT) },
        { messageId: 'om_bot', text: `e2e-fake-ok ${TOKEN}`, createTime: String(SENT_AT + 2_000) },
        { messageId: 'om_dup', text: `e2e-fake-ok ${TOKEN}`, createTime: String(SENT_AT + 3_000) },
      ],
      { token: TOKEN, triggerMessageId: 'om_trigger', sentAtMs: SENT_AT },
    );
    expect(finals.map((item) => item.messageId)).toEqual(['om_bot', 'om_dup']);
  });

  it('does not treat a single bot reply as a duplicate', () => {
    const finals = filterHostSleepFinals(
      [
        { messageId: 'om_trigger', text: `please answer ${TOKEN}`, createTime: String(SENT_AT) },
        { messageId: 'om_bot', text: 'e2e-fake-ok', createTime: String(SENT_AT + 1_000) },
      ],
      { token: TOKEN, triggerMessageId: 'om_trigger', sentAtMs: SENT_AT },
    );
    expect(finals).toHaveLength(1);
  });
});
