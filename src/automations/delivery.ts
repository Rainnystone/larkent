import { Outbox } from '../bot/outbox';
import type { LarkChannel } from '@larksuite/channel';
import type { TurnJournal } from '../bot/turn-journal';
import type { DeliveryChannel } from '../bot/feishu-delivery';
import type { FireSend, FireSender, MissedNotify, MissedNotifier } from './scheduler';
import { zonedParts } from './zoned-time';

export interface AutomationDeliveryDeps {
  journal?: TurnJournal;
  channel: DeliveryChannel;
  botAppId: string;
  botOpenId: () => string;
  isLinkDown: () => boolean;
  now?: () => number;
  outbox?: Outbox;
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
  runAgentFire?: (fire: FireSend) => void | Promise<void>;
}

export function fireTurnId(fireKey: string): string {
  return `af:${fireKey}`;
}

export function missedTurnId(id: number, missedFires: readonly number[]): string {
  const fireAt = missedFires.reduce((min, at) => Math.min(min, at), missedFires[0] ?? 0);
  return `am:${id}@${fireAt}`;
}

export function formatReminderText(
  fire: Pick<FireSend, 'name' | 'taskText' | 'catchUp' | 'timezone' | 'fireAt'>,
  now: number,
): string {
  const base = `⏰ ${fire.name}：${fire.taskText}`;
  if (!fire.catchUp) return base;
  return `${base}（补跑，原定 ${formatScheduledLabel(fire.timezone, fire.fireAt, now)}）`;
}

export function formatMissedNoticeText(
  notice: Pick<MissedNotify, 'name' | 'timezone' | 'missedFires'>,
  now: number,
): string {
  const times = notice.missedFires.map((fireAt) => `原定 ${formatScheduledLabel(notice.timezone, fireAt, now)}`);
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
            return deliverAutomationMarkdown({
              ...deps,
              journal,
              turnId: fireTurnId(fire.fireKey),
              chatId: fire.chatId,
              markdown: formatReminderText(fire, deps.now?.() ?? Date.now()),
              scope: `auto:${fireTurnId(fire.fireKey)}`,
            });
          case 'agent':
            return deps.runAgentFire?.(fire);
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
        return deliverAutomationMarkdown({
          ...deps,
          journal,
          turnId: missedTurnId(notice.id, notice.missedFires),
          chatId: notice.chatId,
          markdown: formatMissedNoticeText(notice, deps.now?.() ?? Date.now()),
          scope: `auto:${missedTurnId(notice.id, notice.missedFires)}`,
        });
      },
    },
  };
}

export function formatScheduledHm(timeZone: string, utcMs: number): string {
  const parts = zonedParts(timeZone, utcMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Same local date as `now` in `timeZone` → `HH:MM`; else `MM-DD HH:MM`; another year → `YYYY-MM-DD HH:MM`. */
export function formatScheduledLabel(timeZone: string, fireAt: number, now: number): string {
  const scheduled = zonedParts(timeZone, fireAt);
  const current = zonedParts(timeZone, now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const hm = formatScheduledHm(timeZone, fireAt);
  if (scheduled.year !== current.year) {
    return `${scheduled.year}-${pad(scheduled.month)}-${pad(scheduled.day)} ${hm}`;
  }
  if (scheduled.month !== current.month || scheduled.day !== current.day) {
    return `${pad(scheduled.month)}-${pad(scheduled.day)} ${hm}`;
  }
  return hm;
}

export async function deliverAutomationMarkdown(input: AutomationDeliveryDeps & {
  journal: TurnJournal;
  turnId: string;
  chatId: string;
  markdown: string;
  scope?: string;
  kind?: 'reminder' | 'result';
}): Promise<void> {
  const outbox = input.outbox ?? new Outbox({
    channel: input.channel as LarkChannel, journal: input.journal,
    botAppId: input.botAppId, isDown: input.isLinkDown,
    now: input.now, onNotInChat: input.onNotInChat, liveSweep: false,
  });
  await outbox.deliverAutomation({
    kind: input.kind ?? 'reminder', turnId: input.turnId, chatId: input.chatId,
    markdown: input.markdown, actor: input.botOpenId(), scope: input.scope,
  });
}
