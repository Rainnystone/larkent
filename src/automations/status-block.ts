import { fireIsMissed } from './schedule';
import type { AutomationsStatusItem } from './store';

export type StatusBlockMissItem = Pick<AutomationsStatusItem, 'paused' | 'nextFireAt' | 'lastFireAt'>;

/** Miss rule from spec §1. Same predicate Larkent uses. */
export function statusBlockIsMissed(item: StatusBlockMissItem, now: number): boolean {
  return fireIsMissed(item, now);
}

/**
 * What a third-party reader of a pinned board sees after Feishu's simplified
 * render: note/markdown text remains; button values and HTML comments do not.
 */
export function simplifiedBoardRender(card: unknown): string {
  const root = asCardObject(card);
  const texts: string[] = [];
  walkVisible(root, texts);
  return texts.join('\n');
}

function asCardObject(card: unknown): unknown {
  if (typeof card !== 'string') return card;
  try {
    return JSON.parse(card);
  } catch {
    return card;
  }
}

function walkVisible(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(stripHtmlComments(node));
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) walkVisible(entry, out);
    return;
  }
  const rec = node as Record<string, unknown>;
  switch (rec.tag) {
    case 'markdown':
      if (typeof rec.content === 'string') out.push(stripHtmlComments(rec.content));
      return;
    case 'div':
      pushTextContent(rec.text, out);
      return;
    case 'action':
      if (Array.isArray(rec.actions)) {
        for (const action of rec.actions) {
          if (action && typeof action === 'object') {
            pushTextContent((action as Record<string, unknown>).text, out);
          }
        }
      }
      return;
    case 'button':
      pushTextContent(rec.text, out);
      return;
    case 'hr':
      return;
    case 'plain_text':
      if (typeof rec.content === 'string') out.push(stripHtmlComments(rec.content));
      return;
    default:
      break;
  }
  if (rec.card) walkVisible(rec.card, out);
  if (rec.body) walkVisible(rec.body, out);
  if (rec.elements) walkVisible(rec.elements, out);
  if (rec.columns) walkVisible(rec.columns, out);
  if (rec.header) walkVisible(rec.header, out);
  if (rec.title) walkVisible(rec.title, out);
}

function pushTextContent(text: unknown, out: string[]): void {
  if (!text || typeof text !== 'object') return;
  const content = (text as Record<string, unknown>).content;
  if (typeof content === 'string') out.push(stripHtmlComments(content));
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}
