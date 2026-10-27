import type { CardActionEvent, CardActionResponse } from '@larksuite/channel';
import { log } from '../core/logger';
import { evaluateAccess } from '../policy/access';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';
import type { UserActionRuntime } from '../user-actions/context';
import { cardActionMessage } from '../user-actions/message';
import { resolveCardUserAction } from '../user-actions/registry';

type RawCardActionEvent = CardActionEvent & {
  raw?: { create_time?: unknown; action?: { form_value?: Record<string, unknown> } };
};

export async function handleCardAction(
  deps: UserActionRuntime & { evt: CardActionEvent },
): Promise<CardActionResponse | void> {
  const startedAt = Date.now();
  const value = deps.evt.action.value;
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const cmd = typeof payload?.cmd === 'string' ? payload.cmd : '';
  log.info('cardAction', 'received', { cmd, ...feishuLag(deps.evt, startedAt) });
  try {
    if (!payload || !deps.chatModeCache) return;
    const mode = await deps.chatModeCache.resolve(deps.channel, deps.evt.chatId);
    const threadId = mode === 'topic' ? await lookupMessageThreadId(deps.channel, deps.evt.messageId) : undefined;
    const scope = threadId ? `${deps.evt.chatId}:${threadId}` : deps.evt.chatId;
    const access = evaluateAccess({
      entry: 'card', profile: deps.controls.profileConfig, controls: deps.controls,
      chatId: deps.evt.chatId, senderId: deps.evt.operator.openId,
      chatMode: mode === 'p2p' ? 'p2p' : 'group',
    });
    if (!access.ok) {
      log.info('cardAction', 'skip-not-allowed-user', { operator: deps.evt.operator.openId.slice(-6), reason: access.reason });
      return;
    }
    const action = resolveCardUserAction(payload);
    if (!action) return;
    const msg = cardActionMessage(deps.evt, mode, threadId);
    const raw = (deps.evt as RawCardActionEvent).raw;
    return await action.invoke({
      ...deps, msg, scope, chatMode: mode, origin: 'card',
      formValue: raw?.action?.form_value,
      resolveSessionCatalogIdentity: () => commandSessionCatalogIdentity({
        msg, scope, mode, workspaces: deps.workspaces, controls: deps.controls, access,
      }),
    }, payload);
  } finally {
    log.info('cardAction', 'responded', { cmd, ms: Date.now() - startedAt });
  }
}

function feishuLag(evt: CardActionEvent, receivedAt: number): { feishuLagMs?: number } {
  const createTime = Number((evt as RawCardActionEvent).raw?.create_time);
  if (!Number.isFinite(createTime) || createTime <= 0) return {};
  return { feishuLagMs: receivedAt - (createTime > 1e14 ? Math.round(createTime / 1000) : createTime) };
}
