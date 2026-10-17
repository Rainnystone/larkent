import type { ProfileConfig } from '../config/profile-schema';
import { getRequireMentionInGroup, type AppConfig } from '../config/schema';
export { accessPolicyDigest } from './fingerprint';

export type OwnerRefreshState = 'ok' | 'failed' | 'unknown';

export interface RuntimeControls {
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
}

export type AccessEntry = 'dm' | 'group' | 'comment' | 'meeting' | 'card';

export interface AccessDecision {
  ok: boolean;
  reason:
    | 'owner'
    | 'allowed-team'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-chat'
    | 'admitted'
    | 'comment-mention'
    | 'denied-user'
    | 'denied-chat'
    | 'denied-admin';
}

export interface EvaluateAccessInput {
  entry: AccessEntry;
  profile: ProfileConfig;
  controls: RuntimeControls;
  chatId: string;
  senderId: string;
  chatMode?: 'p2p' | 'group';
}

export function isCreator(controls: RuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}

export function isAccessFenceEnabled(profile: ProfileConfig): boolean {
  return profile.access.fence?.enabled === true;
}

/**
 * Single access decision used by DM, group, comment, meeting, and card
 * clicks. When the profile fence is on, owner/admin/team exemptions are
 * ignored: chat must be in `allowedChats` and sender in `allowedUsers`.
 */
export function evaluateAccess(input: EvaluateAccessInput): AccessDecision {
  if (isAccessFenceEnabled(input.profile)) {
    return evaluateAccessFence(input.profile, input.chatId, input.senderId, input.entry);
  }
  switch (input.entry) {
    case 'dm':
      return evaluateDm(input.profile, input.controls, input.senderId);
    case 'group':
      return evaluateGroup(input.profile, input.controls, input.chatId, input.senderId);
    case 'comment':
      return allow('comment-mention');
    case 'meeting':
      return allow('allowed-chat');
    case 'card':
      return (input.chatMode ?? 'group') === 'p2p'
        ? evaluateDm(input.profile, input.controls, input.senderId)
        : evaluateGroup(input.profile, input.controls, input.chatId, input.senderId);
    default: {
      const _exhaustive: never = input.entry;
      return _exhaustive;
    }
  }
}

export function canUseDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
  chatId = '',
): AccessDecision {
  return evaluateAccess({ entry: 'dm', profile, controls, chatId, senderId });
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  return evaluateAccess({ entry: 'group', profile, controls, chatId, senderId });
}

/**
 * Whether a group message must @-mention the bot to be handled. A per-chat
 * override (profile.access.chatRequireMention[chatId]) takes priority over the
 * global requireMentionInGroup (from cfg). p2p chats never call this.
 */
export function requireMentionForChat(
  profile: ProfileConfig,
  cfg: AppConfig,
  chatId: string,
): boolean {
  const override = profile.access.chatRequireMention?.[chatId];
  return typeof override === 'boolean' ? override : getRequireMentionInGroup(cfg);
}

export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

function evaluateAccessFence(
  profile: ProfileConfig,
  chatId: string,
  senderId: string,
  entry: AccessEntry,
): AccessDecision {
  if (entry === 'comment') {
    if (!profile.access.allowedUsers.includes(senderId)) return deny('denied-user');
    return allow('allowed-user');
  }
  if (!profile.access.allowedChats.includes(chatId)) return deny('denied-chat');
  if (!profile.access.allowedUsers.includes(senderId)) return deny('denied-user');
  return allow('allowed-user');
}

function evaluateDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  // Team mode opens up *usage* to everyone — no allowlist gating. Admin
  // commands stay owner/admin-gated via canRunAdminCommand (unchanged).
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-user');
}

function evaluateGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.access.allowedChats.includes(chatId)) return allow('allowed-chat');
  return deny('denied-chat');
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
