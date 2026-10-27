import { log } from '../core/logger';
import { senderTypeFromMessage } from '../bot/self-message';
import { abandonIfNotInChat } from './chat-lifecycle';
import type { CommandContext } from '../commands';
import { formatAutomationListLine } from './board-card';
import { mutateAutomationTask, taskMutationLabels } from './task-mutation';
import { AUTO_NEW_USAGE, AUTO_P2P_HINT, AUTO_AGENT_DISABLED, AUTO_LIST_EMPTY, AUTO_UNKNOWN_ID, parseAutoNewArgs, assessAutomationSchedule, rejectMessage, noteAutomationRejected, scheduleStartAt, scheduleEndAt, type ParsedAutoNew, type AutomationRejectSource } from './command-schedule';
import { nextFireAfter } from './schedule';
import { submitDraft } from './draft-confirmation';
export * from './command-schedule';
export type AutomationCommandContext = Pick<
  CommandContext,
  | 'channel'
  | 'msg'
  | 'scope'
  | 'chatMode'
  | 'workspaces'
  | 'automations'
  | 'autoAuth'
  | 'automationsScheduler'
  | 'now'
  | 'controls'
  | 'isLinkDown'
>;

export type ParsedAutoCommand =
  | ParsedAutoNew & { op: 'new' }
  | { op: 'list' }
  | { op: 'pause' | 'resume' | 'delete'; id: number }
  | { op: 'usage' };

export function parseAutoCommand(args: string): ParsedAutoCommand {
  const trimmed = args.trim();
  if (!trimmed || /^list$/i.test(trimmed)) return { op: 'list' };
  const mutate = trimmed.match(/^(pause|resume|delete)\s+(\d+)$/i);
  if (mutate) {
    const id = Number(mutate[2]);
    if (!Number.isInteger(id) || id < 1) return { op: 'usage' };
    const op = mutate[1]!.toLowerCase();
    if (op !== 'pause' && op !== 'resume' && op !== 'delete') return { op: 'usage' };
    return { op, id };
  }
  const parsed = parseAutoNewArgs(trimmed);
  if ('ok' in parsed) return { op: 'usage' };
  return { op: 'new', ...parsed };
}

export async function handleAutoCommand(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.controls.profileConfig.automations.enabled) return;
  if (isIgnoredAutoSender(ctx)) return;
  if (ctx.scope.startsWith('auto:') || ctx.scope.startsWith('meeting:')) return;
  if (ctx.chatMode === 'p2p' || ctx.msg.chatType === 'p2p') {
    await replyAuto(ctx, AUTO_P2P_HINT);
    return;
  }

  const parsed = parseAutoCommand(args);
  switch (parsed.op) {
    case 'list':
      await listAutos(ctx);
      return;
    case 'pause':
    case 'resume':
    case 'delete':
      await mutateAuto(ctx, parsed.op, parsed.id);
      return;
    case 'usage':
      await replyAuto(ctx, AUTO_NEW_USAGE);
      return;
    case 'new':
      await submitAutomationCommand(ctx, parsed);
      return;
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

export async function submitAutomationCommand(
  ctx: AutomationCommandContext,
  parsed: ParsedAutoNew,
  source: AutomationRejectSource = 'command',
): Promise<void> {
  if (!ctx.controls.profileConfig.automations.enabled) return;
  if (isIgnoredAutoSender(ctx)) return;
  if (ctx.scope.startsWith('auto:') || ctx.scope.startsWith('meeting:')) return;
  if (ctx.chatMode === 'p2p' || ctx.msg.chatType === 'p2p') {
    await replyAuto(ctx, AUTO_P2P_HINT);
    return;
  }

  if (parsed.taskType === 'agent' && !ctx.controls.profileConfig.automations.agentTasks) {
    await replyAuto(ctx, AUTO_AGENT_DISABLED);
    return;
  }

  if (!ctx.automations || !ctx.autoAuth) {
    await replyAuto(ctx, AUTO_NEW_USAGE);
    return;
  }

  const now = (ctx.now ?? Date.now)();
  const timezone = ctx.controls.profileConfig.automations.timezone;
  const cwd = parsed.taskType === 'agent'
    ? ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default
    : undefined;
  const verdict = assessAutomationSchedule({
    taskType: parsed.taskType,
    scheduleText: parsed.scheduleText,
    now,
    timezone,
    hasCwd: typeof cwd === 'string' && cwd.trim().length > 0,
  });
  switch (verdict.outcome) {
    case 'refuse':
      await replyAuto(ctx, verdict.message);
      return;
    case 'reject':
      noteAutomationRejected(verdict.reason, source);
      await replyAuto(ctx, rejectMessage(verdict.reason, verdict));
      return;
    case 'needs-end': {
      const draft = await submitDraft(ctx, {
        cardReply: { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}) },
        taskType: parsed.taskType,
        schedule: verdict.pending,
        timezone,
        startAt: verdict.startAt ?? now,
        nextFireAt: 0,
        chatId: ctx.msg.chatId,
        createdBy: ctx.msg.senderId,
        name: parsed.name,
        taskText: parsed.taskText,
        pendingRecurring: verdict.pending,
        ...(cwd ? { cwd } : {}),
      });
      if (ctx.automations.getDraft(draft.draftId)) {
        log.info('auto', 'draft', {
          draftId: draft.draftId,
          taskType: parsed.taskType,
          chatId: ctx.msg.chatId,
          waiting: 'end',
        });
      }
      return;
    }
    case 'confirm': {
      const nextFireAt = nextFireAfter(verdict.schedule, now);
      const startAt = scheduleStartAt(verdict.schedule, now);
      const endAt = scheduleEndAt(verdict.schedule);
      const draft = await submitDraft(ctx, {
        cardReply: { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}) },
        taskType: parsed.taskType,
        schedule: verdict.schedule,
        timezone,
        startAt,
        ...(endAt !== undefined ? { endAt } : {}),
        nextFireAt,
        chatId: ctx.msg.chatId,
        createdBy: ctx.msg.senderId,
        name: parsed.name,
        taskText: parsed.taskText,
        ...(cwd ? { cwd } : {}),
      });
      if (ctx.automations.getDraft(draft.draftId)) {
        log.info('auto', 'draft', {
          draftId: draft.draftId,
          taskType: parsed.taskType,
          chatId: ctx.msg.chatId,
        });
      }
      return;
    }
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

async function listAutos(ctx: CommandContext): Promise<void> {
  if (!ctx.automations) {
    await replyAuto(ctx, AUTO_LIST_EMPTY);
    return;
  }
  const items = ctx.automations.list().filter((item) => item.chatId === ctx.msg.chatId);
  if (items.length === 0) {
    await replyAuto(ctx, AUTO_LIST_EMPTY);
    return;
  }
  await replyAuto(ctx, items.map(formatAutomationListLine).join('\n'));
}

async function mutateAuto(
  ctx: CommandContext,
  op: 'pause' | 'resume' | 'delete',
  id: number,
): Promise<void> {
  if (!ctx.automations || !ctx.automationsScheduler) {
    await replyAuto(ctx, AUTO_UNKNOWN_ID);
    return;
  }
  const result = await mutateAutomationTask({ store: ctx.automations, scheduler: ctx.automationsScheduler, chatId: ctx.msg.chatId, now: ctx.now }, { actor: 'human', operation: op, id });
  if (result.ok) log.info('auto', { pause: 'paused', resume: 'resumed', delete: 'deleted' }[op], { id });
  await replyAuto(ctx, result.ok ? `已${taskMutationLabels[op]} #${id} ${result.item.name}` : AUTO_UNKNOWN_ID);
}

function isIgnoredAutoSender(ctx: Pick<CommandContext, 'msg' | 'channel'>): boolean {
  const senderType = senderTypeFromMessage(ctx.msg);
  if (senderType === 'app' || senderType === 'bot') return true;
  const botOpenId = ctx.channel.botIdentity?.openId;
  return Boolean(botOpenId) && ctx.msg.senderId === botOpenId;
}

async function replyAuto(ctx: AutomationCommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(
      ctx.msg.chatId,
      { markdown },
      {
        replyTo: ctx.msg.messageId,
        ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
      },
    );
  } catch (err) {
    if (await abandonIfNotInChat(err, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
      return;
    }
    log.warn('auto', 'reply-failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
