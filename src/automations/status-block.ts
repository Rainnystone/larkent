import { fireIsMissed } from './schedule';
import type { AutomationLastStatus, AutomationsStatusItem, AutomationsStatusSnapshot } from './store';

export type StatusBlockMissItem = Pick<AutomationsStatusItem, 'paused' | 'nextFireAt' | 'lastFireAt'>;

/** Miss rule from spec §1, applied to a status-block item. Same predicate Larkent uses. */
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

export function parseStatusBlock(text: string): AutomationsStatusSnapshot | undefined {
  const source = text.includes('{\\"v\\":1') ? text.replace(/\\"/g, '"') : text;
  const json = extractJsonObject(source);
  if (!json) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  return parseSnapshot(raw);
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
  if (rec.elements) walkVisible(rec.elements, out);
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

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{"v":1');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseSnapshot(raw: unknown): AutomationsStatusSnapshot | undefined {
  if (!isObject(raw) || raw.v !== 1 || typeof raw.bot !== 'string' || !isFiniteNumber(raw.updatedAt)) {
    return undefined;
  }
  if (!Array.isArray(raw.items)) return undefined;
  const items: AutomationsStatusItem[] = [];
  for (const entry of raw.items) {
    const item = parseItem(entry);
    if (!item) return undefined;
    items.push(item);
  }
  return { v: 1, bot: raw.bot, updatedAt: raw.updatedAt, items };
}

function parseItem(raw: unknown): AutomationsStatusItem | undefined {
  if (!isObject(raw)) return undefined;
  if (!isPositiveInt(raw.id) || typeof raw.paused !== 'boolean') return undefined;
  if (!isFiniteNumber(raw.nextFireAt) || !isFiniteNumber(raw.lastFireAt) || !isFiniteNumber(raw.endAt)) {
    return undefined;
  }
  if (!isFiniteNumber(raw.missed) || !isLastStatus(raw.lastStatus)) return undefined;
  return {
    id: raw.id,
    paused: raw.paused,
    nextFireAt: raw.nextFireAt,
    lastFireAt: raw.lastFireAt,
    lastStatus: raw.lastStatus,
    endAt: raw.endAt,
    missed: raw.missed,
  };
}

function isLastStatus(value: unknown): value is AutomationLastStatus {
  return value === 'ok' || value === 'missed' || value === 'failed' || value === 'running';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
