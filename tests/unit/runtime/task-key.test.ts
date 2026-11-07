import { describe, expect, it } from 'vitest';
import { computeRunTaskKey } from '../../../src/runtime/task-key.js';
import { specTaskKey } from '../../helpers/spec-task-key.js';

const PROFILE = 'claude';
const OTHER_PROFILE = 'codex';
const CHAT = 'oc_abcdefghijklmnopqrstuvwxyz123456';
const OTHER_CHAT = 'oc_otherchat_full_identity_999999';
const MSG = 'om_source_message_abcdef789012';
const OTHER_MSG = 'om_other_message_fedcba654321';

describe('run started taskKey', () => {
  it('is 32 hex chars of sha256(profile + newline + chatId + newline + sourceMessageId)', () => {
    const key = computeRunTaskKey(PROFILE, CHAT, MSG);
    expect(key).toBe(specTaskKey(PROFILE, CHAT, MSG));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same profile, chat, and message across retry/restart run ids', () => {
    const first = computeRunTaskKey(PROFILE, CHAT, MSG);
    const retried = computeRunTaskKey(PROFILE, CHAT, MSG);
    expect(retried).toBe(first);
  });

  it('differs across profiles, messages, and chats so tasks are never merged', () => {
    const baseline = computeRunTaskKey(PROFILE, CHAT, MSG);
    expect(computeRunTaskKey(OTHER_PROFILE, CHAT, MSG)).not.toBe(baseline);
    expect(computeRunTaskKey(PROFILE, CHAT, OTHER_MSG)).not.toBe(baseline);
    expect(computeRunTaskKey(PROFILE, OTHER_CHAT, MSG)).not.toBe(baseline);
  });

  it('does not embed the raw profile, chat id, or message id', () => {
    const key = computeRunTaskKey(PROFILE, CHAT, MSG);
    expect(key).not.toContain(PROFILE);
    expect(key).not.toContain(CHAT);
    expect(key).not.toContain(MSG);
  });
});
