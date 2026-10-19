/**
 * CardKit schema 2.0 shape check. Feishu card.create answers a 1.0 body
 * with code 200610 "body is nil" and no card_id.
 */
export class CardSchemaError extends Error {
  readonly code = 200610;
  readonly msg: string;
  readonly response: { data: { code: number; msg: string } };

  constructor(msg = 'body is nil') {
    super(msg);
    this.name = 'CardSchemaError';
    this.msg = msg;
    this.response = { data: { code: 200610, msg } };
  }
}

export function assertCardSchema2(card: unknown): void {
  const problems = schemaProblems(card);
  if (problems.length > 0) throw new CardSchemaError();
}

function schemaProblems(card: unknown): string[] {
  if (!isRecord(card)) return ['root'];
  const problems: string[] = [];
  if (card.schema !== '2.0') problems.push('schema');
  if ('elements' in card) problems.push('top-level-elements');
  const body = card.body;
  if (!isRecord(body) || !Array.isArray(body.elements)) problems.push('body.elements');
  walk(card, false, problems);
  return problems;
}

function walk(node: unknown, inForm: boolean, problems: string[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, inForm, problems);
    return;
  }
  if (!isRecord(node)) return;
  const tag = node.tag;
  if (tag === 'action') problems.push('action');
  if (tag === 'button') checkButton(node, problems);
  if (tag === 'input' && !inForm) problems.push('input-outside-form');
  if (tag === 'form' && treeHas(node, (entry) => entry.tag === 'input') && !treeHas(node, isSubmitButton)) {
    problems.push('form-submit');
  }
  const childInForm = inForm || tag === 'form';
  for (const value of Object.values(node)) walk(value, childInForm, problems);
}

function checkButton(node: Record<string, unknown>, problems: string[]): void {
  const behaviors = node.behaviors;
  if (!Array.isArray(behaviors)) {
    problems.push('button-behaviors');
    return;
  }
  const callback = behaviors.find((entry) => isRecord(entry) && entry.type === 'callback');
  if (!isRecord(callback) || !isRecord(callback.value) || typeof callback.value.cmd !== 'string' || !callback.value.cmd) {
    problems.push('button-callback');
  }
}

function isSubmitButton(node: Record<string, unknown>): boolean {
  return node.tag === 'button' && node.form_action_type === 'submit';
}

function treeHas(node: unknown, pred: (entry: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(node)) return node.some((entry) => treeHas(entry, pred));
  if (!isRecord(node)) return false;
  if (pred(node)) return true;
  return Object.values(node).some((value) => treeHas(value, pred));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
