import { buttonRow, callbackButton, card2, hr, md } from '../card/v2';
import { describeEnd, formatZonedDateTime } from './confirm-card';
import { readSchedule } from './schedule';
import type { AutomationItem } from './store';
import type { BoardActionAuth } from './board-auth';
import { BOARD_CARD_TTL_MS } from './board-auth';

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
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

export const BOARD_UPDATED_TEXT = '此看板已更新，请查看置顶的新看板。';

const BOARD_TITLE = '本群自动化';

export function automationBoardSettledCard(): object {
  return card2({
    title: BOARD_TITLE,
    summary: BOARD_TITLE,
    elements: [md(BOARD_UPDATED_TEXT)],
  });
}

export function automationBoardCard(input: {
  items: AutomationItem[];
  auth: BoardActionAuth;
}): object {
  const elements: object[] = [];
  if (input.items.length === 0) {
    elements.push(md('暂无'));
  } else {
    input.items.forEach((item, index) => {
      elements.push(md(formatTaskRow(item)));
      elements.push(buttonRow(taskButtons(item, input.auth)));
      for (const missed of [...item.missedInstants].sort((a, b) => a.fireAt - b.fireAt)) {
        elements.push(md(
          `已错过 原定 ${formatZonedDateTime(item.timezone, missed.fireAt)}`,
        ));
      }
      for (const skipped of [...item.skippedInstants].sort((a, b) => a.fireAt - b.fireAt)) {
        elements.push(md(
          `已跳过 原定 ${formatZonedDateTime(item.timezone, skipped.fireAt)}`,
        ));
      }
      if (index < input.items.length - 1) elements.push(hr);
    });
  }
  return card2({ title: BOARD_TITLE, summary: BOARD_TITLE, elements });
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

function taskButtons(item: AutomationItem, auth: BoardActionAuth): object[] {
  const mutate = item.paused
    ? callbackButton({
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
      })
    : callbackButton({
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
      });
  return [
    mutate,
    callbackButton({
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
    }),
  ];
}
