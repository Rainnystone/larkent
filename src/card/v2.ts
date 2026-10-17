export interface CallbackButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
  name?: string;
  formAction?: 'submit' | 'reset';
}

export function card2(input: { title: string; summary: string; elements: object[] }): object {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: input.summary } },
    header: { title: { tag: 'plain_text', content: input.title } },
    body: { elements: input.elements },
  };
}

export function md(content: string): object {
  return { tag: 'markdown', content };
}

export function note(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

export const hr: object = { tag: 'hr' };

export function callbackButton(spec: CallbackButtonSpec): object {
  return {
    tag: 'button',
    ...(spec.name ? { name: spec.name } : {}),
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    ...(spec.formAction ? { form_action_type: spec.formAction } : {}),
    behaviors: [{ type: 'callback', value: spec.value }],
  };
}

export function buttonRow(buttons: object[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'auto',
      elements: [button],
    })),
  };
}

export function form(name: string, elements: object[]): object {
  return { tag: 'form', name, elements };
}
