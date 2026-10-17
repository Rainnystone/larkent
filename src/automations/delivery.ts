import { classify } from '../bot/feishu-error';
import { redeliverStagedReply, type DeliveryChannel } from '../bot/feishu-delivery';
import {
  replyDeliveryKey,
  replyState,
  type TurnJournal,
  type TurnJournalEntry,
} from '../bot/turn-journal';
import { log } from '../core/logger';
import type { FireSend, FireSender, MissedNotify, MissedNotifier } from './scheduler';
import { zonedParts } from './zoned-time';

/** Top-level fire: no triggering message. Empty `replyTo` means a chat root send. */
const TOP_LEVEL_REPLY_TO = '';

export interface AutomationDeliveryDeps {
  journal?: TurnJournal;
  channel: DeliveryChannel;
  botAppId: string;
  botOpenId: () => string;
  isLinkDown: () => boolean;
  now?: () => number;
  deliver?: (entry: TurnJournalEntry) => Promise<boolean>;
  onUndelivered?: () => void;
}

export function fireTurnId(fireKey: string): string {
  return `af:${fireKey}`;
}

export function missedTurnId(id: number, missedFires: readonly number[]): string {
  const fireAt = missedFires.reduce((min, at) => Math.min(min, at), missedFires[0] ?? 0);
  return `am:${id}@${fireAt}`;
}

export function formatReminderText(fire: Pick<FireSend, 'name' | 'taskText' | 'catchUp' | 'timezone' | 'fireAt'>): string {
  const base = `⏰ ${fire.name}：${fire.taskText}`;
  if (!fire.catchUp) return base;
  return `${base}（补跑，原定 ${formatHm(fire.timezone, fire.fireAt)}）`;
}

export function formatMissedNoticeText(notice: Pick<MissedNotify, 'name' | 'timezone' | 'missedFires'>): string {
  const times = notice.missedFires.map((fireAt) => `原定 ${formatHm(notice.timezone, fireAt)}`);
  return [`已错过：${notice.name}`, ...times].join('\n');
}

export function createAutomationDelivery(deps: AutomationDeliveryDeps): {
  sender: FireSender;
  notifier: MissedNotifier;
} {
  if (!deps.journal) {
    return {
      sender: { send: async () => {} },
      notifier: { notify: async () => {} },
    };
  }
  const journal = deps.journal;
  return {
    sender: {
      send: (fire) => {
        switch (fire.taskType) {
          case 'reminder':
            return deliverMarkdown({
              ...deps,
              journal,
              turnId: fireTurnId(fire.fireKey),
              chatId: fire.chatId,
              markdown: formatReminderText(fire),
            });
          case 'agent':
            return;
          default: {
            const _exhaustive: never = fire.taskType;
            throw _exhaustive;
          }
        }
      },
    },
    notifier: {
      notify: (notice) => {
        if (notice.missedFires.length === 0) return;
        return deliverMarkdown({
          ...deps,
          journal,
          turnId: missedTurnId(notice.id, notice.missedFires),
          chatId: notice.chatId,
          markdown: formatMissedNoticeText(notice),
        });
      },
    },
  };
}

function formatHm(timeZone: string, utcMs: number): string {
  const parts = zonedParts(timeZone, utcMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

async function deliverMarkdown(input: AutomationDeliveryDeps & {
  journal: TurnJournal;
  turnId: string;
  chatId: string;
  markdown: string;
}): Promise<void> {
  const existing = input.journal.get(input.turnId);
  if (existing && replyState(existing) === 'sent') return;
  if (!existing) {
    const actor = input.botOpenId();
    input.journal.enqueue({
      turnId: input.turnId,
      scope: `auto:${input.turnId}`,
      chatId: input.chatId,
      messageIds: [],
      senderId: actor,
      initiatorId: actor,
      initiatorType: 'bot',
      status: 'settled',
    });
  }
  const current = input.journal.get(input.turnId);
  if (!current || replyState(current) !== 'sent') {
    input.journal.stageReply(input.turnId, {
      markdown: input.markdown,
      replyTo: TOP_LEVEL_REPLY_TO,
      replyMode: 'text',
      deliveryId: replyDeliveryKey(input.turnId),
    });
  }
  await input.journal.flush();
  if (input.isLinkDown()) return;
  const entry = input.journal.get(input.turnId);
  if (!entry?.reply) return;
  try {
    const delivered = input.deliver
      ? await input.deliver(entry)
      : (await redeliverStagedReply({
          channel: input.channel,
          entry,
          botAppId: input.botAppId,
          ...(input.now ? { now: input.now } : {}),
        })).delivered;
    if (delivered) {
      input.journal.replyDelivered(input.turnId);
      await input.journal.flush();
      return;
    }
    input.onUndelivered?.();
  } catch (error) {
    const kind = classify(error);
    switch (kind) {
      case 'rejected':
        input.journal.replyRejected(input.turnId);
        await input.journal.flush();
        return;
      case 'link':
      case 'local':
        log.warn('auto', 'deliver-failed', {
          turnId: input.turnId,
          err: error instanceof Error ? error.message : String(error),
        });
        input.onUndelivered?.();
        return;
      default: {
        const _exhaustive: never = kind;
        throw _exhaustive;
      }
    }
  }
}
