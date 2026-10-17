import { describeEnd, formatZonedDateTime } from './confirm-card';
import { readSchedule } from './schedule';
import type { AutomationItem, AutomationsStatusSnapshot } from './store';
import type { BoardActionAuth } from './board-auth';
import { BOARD_CARD_TTL_MS } from './board-auth';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

export function chatStatusSnapshot(
  snapshot: AutomationsStatusSnapshot | undefined,
  items: AutomationItem[],
  fallback: { bot: string; updatedAt: number },
): AutomationsStatusSnapshot {
  const ids = new Set(items.map((item) => item.id));
  return {
    v: 1,
    bot: snapshot?.bot ?? fallback.bot,
    updatedAt: snapshot?.updatedAt ?? fallback.updatedAt,
    items: (snapshot?.items ?? []).filter((item) => ids.has(item.id)),
  };
}

export function formatAutomationListLine(item: AutomationItem): string {
  return [
    `#${item.id} ${item.name}`,
    item.taskType === 'reminder' ? '提醒' : 'agent 任务',
    `下次 ${formatNextFire(item)}`,
    `结束 ${formatEnd(item)}`,
    describeItemStatus(item),
  ].join(' · ');
}

export function automationBoardCard(input: {
  items: AutomationItem[];
  status: AutomationsStatusSnapshot;
  auth: BoardActionAuth;
}): object {
  const elements: object[] = [];
  if (input.items.length === 0) {
    elements.push(divMd('暂无'));
  } else {
    input.items.forEach((item, index) => {
      elements.push(divMd(formatTaskRow(item)));
      elements.push(actions(taskButtons(item, input.auth)));
      for (const missed of [...item.missedInstants].sort((a, b) => a.fireAt - b.fireAt)) {
        elements.push(divMd(
          `已错过 原定 ${formatZonedDateTime(item.timezone, missed.fireAt)}`,
        ));
      }
      for (const skipped of [...item.skippedInstants].sort((a, b) => a.fireAt - b.fireAt)) {
        elements.push(divMd(
          `已跳过 原定 ${formatZonedDateTime(item.timezone, skipped.fireAt)}`,
        ));
      }
      if (index < input.items.length - 1) elements.push(HR);
    });
  }
  elements.push(HR);
  elements.push(noteMd(JSON.stringify(input.status)));
  return shell('本群自动化', elements);
}

function formatTaskRow(item: AutomationItem): string {
  return [
    `**#${item.id} ${escapeMd(item.name)}** · ${item.taskType === 'reminder' ? '提醒' : 'agent 任务'}`,
    `下次 ${escapeMd(formatNextFire(item))} · 结束 ${escapeMd(formatEnd(item))} · ${describeItemStatus(item)}`,
  ].join('\n');
}

function formatNextFire(item: AutomationItem): string {
  if (item.nextFireAt <= 0) return '无';
  return formatZonedDateTime(item.timezone, item.nextFireAt);
}

function formatEnd(item: AutomationItem): string {
  const schedule = readSchedule(item.schedule);
  if (!schedule) return item.endAt > 0 ? formatZonedDateTime(item.timezone, item.endAt) : '无';
  return describeEnd(schedule, item.timezone);
}

function describeItemStatus(item: AutomationItem): string {
  if (item.paused) return '已暂停';
  switch (item.lastStatus) {
    case 'ok':
      return '待触发';
    case 'running':
      return '进行中';
    case 'missed':
      return '已错过';
    case 'failed':
      return '失败';
    default: {
      const _exhaustive: never = item.lastStatus;
      return _exhaustive;
    }
  }
}

function taskButtons(item: AutomationItem, auth: BoardActionAuth): ButtonSpec[] {
  const mutate: ButtonSpec = item.paused
    ? {
        text: '恢复',
        value: {
          cmd: 'auto.resume',
          auto_token: auth.sign({
            chatId: item.chatId,
            itemId: item.id,
            action: 'auto.resume',
            ttlMs: BOARD_CARD_TTL_MS,
          }),
        },
        style: 'primary',
      }
    : {
        text: '暂停',
        value: {
          cmd: 'auto.pause',
          auto_token: auth.sign({
            chatId: item.chatId,
            itemId: item.id,
            action: 'auto.pause',
            ttlMs: BOARD_CARD_TTL_MS,
          }),
        },
      };
  return [
    mutate,
    {
      text: '删除',
      value: {
        cmd: 'auto.delete',
        auto_token: auth.sign({
          chatId: item.chatId,
          itemId: item.id,
          action: 'auto.delete',
          ttlMs: BOARD_CARD_TTL_MS,
        }),
      },
      style: 'danger',
    },
  ];
}
