import { buttonRow, callbackButton, card2, form, hr, md } from '../card/v2';
import type { AutoCardAction } from './action-auth';

export const END_CARD_PRESETS = [
  { cmd: 'auto.end.1m', text: '一个月' },
  { cmd: 'auto.end.3m', text: '三个月' },
  { cmd: 'auto.end.eoy', text: '今年年底' },
  { cmd: 'auto.end.1y', text: '一年' },
] as const satisfies ReadonlyArray<{ cmd: AutoCardAction; text: string }>;

export type EndCardTokens = {
  'auto.end.1m': string;
  'auto.end.3m': string;
  'auto.end.eoy': string;
  'auto.end.1y': string;
  'auto.end.custom': string;
  'auto.reject': string;
};

export function automationEndCard(tokens: EndCardTokens): object {
  return card2({
    title: '指定结束时间',
    summary: '指定结束时间',
    elements: [
      md('周期任务必须指定结束时间。请选择常用时长，或输入结束日期。'),
      buttonRow(END_CARD_PRESETS.map((preset, index) => callbackButton({
        text: preset.text,
        value: { cmd: preset.cmd, auto_token: tokens[preset.cmd] },
        style: index === 0 ? 'primary' : 'default',
      }))),
      hr,
      form('auto_end', [
        {
          tag: 'input',
          name: 'end_at',
          placeholder: { tag: 'plain_text', content: 'YYYY-MM-DD 或 YYYY-MM-DD HH:MM' },
        },
        buttonRow([
          callbackButton({
            text: '提交',
            name: 'submit_end',
            value: { cmd: 'auto.end.custom', auto_token: tokens['auto.end.custom'] },
            style: 'primary',
            formAction: 'submit',
          }),
        ]),
      ]),
      buttonRow([
        callbackButton({
          text: '取消',
          value: { cmd: 'auto.reject', auto_token: tokens['auto.reject'] },
        }),
      ]),
    ],
  });
}
