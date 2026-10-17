import type { AutoCardAction } from './action-auth';

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

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

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
  return shell('指定结束时间', [
    divMd('周期任务必须指定结束时间。请选择常用时长，或输入结束日期。'),
    actions(END_CARD_PRESETS.map((preset, index) => ({
      text: preset.text,
      value: { cmd: preset.cmd, auto_token: tokens[preset.cmd] },
      style: index === 0 ? 'primary' : 'default',
    }))),
    HR,
    {
      tag: 'input',
      name: 'end_at',
      placeholder: { tag: 'plain_text', content: 'YYYY-MM-DD 或 YYYY-MM-DD HH:MM' },
    },
    actions([
      {
        text: '提交',
        value: { cmd: 'auto.end.custom', auto_token: tokens['auto.end.custom'] },
        style: 'primary',
      },
      {
        text: '取消',
        value: { cmd: 'auto.reject', auto_token: tokens['auto.reject'] },
      },
    ]),
  ]);
}
