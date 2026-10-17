import { describe, expect, it } from 'vitest';
import { inspectAutomationToolUse } from '../../../src/automations/policy-guard';

describe('automation policy-guard whitelist', () => {
  it.each([
    ['lark-cli im chat.members create --chat-id oc_x --data {"id_list":["ou_a"]}', 'members'],
    ['lark-cli im chat.members delete --chat-id oc_x --data {"id_list":["ou_a"]}', 'members'],
    ['lark-cli im +chat-create --name team', 'chat-create'],
    ['lark-cli im chats create --name team', 'chat-create'],
    ['lark-cli im chats delete --chat-id oc_x', 'leave'],
    ['lark-cli im chat.members.me_leave --chat-id oc_x', 'leave'],
    ['bash -c "lark-cli im +chat-create --name extra"', 'chat-create'],
    ['lark-cli im +chat-update --chat-id oc_x --name n', 'chat-settings'],
    ['lark-cli contact +search-user --query alice', 'contacts'],
    ['lark-cli corehr employees search', 'hr'],
    ['lark-cli im +chat-messages-list --chat-id oc_x --as user', 'user-identity'],
    ['lark-cli auth login --no-wait', 'user-identity'],
    ['lark-cli config strict-mode off', 'user-identity'],
  ] as const)('blocks %s as %s', (command, reason) => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command } })).toEqual({ reason });
  });

  it.each([
    'lark-cli im +chat-messages-list --chat-id oc_group',
    'lark-cli im +messages-send --chat-id oc_group --text hi',
    'lark-cli im +chat-members-list --chat-id oc_group',
    'lark-cli im +messages-search --query standup --as bot',
    'lark-cli docs +content --token docx',
    'pwd',
    'git status',
    'echo chats create',
  ])('allows %s', (command) => {
    expect(inspectAutomationToolUse({ name: 'Bash', input: { command } })).toBeUndefined();
  });

  it('treats personnel/org tool names as blocked even without argv', () => {
    expect(inspectAutomationToolUse({ name: 'im_chat_members_create', input: {} })).toEqual({
      reason: 'members',
    });
    expect(inspectAutomationToolUse({ name: 'im.chats.create', input: {} })).toEqual({
      reason: 'chat-create',
    });
    expect(inspectAutomationToolUse({ name: 'contact_search_user', input: {} })).toEqual({
      reason: 'contacts',
    });
  });
});
