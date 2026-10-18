import { card2, md } from '../card/v2';

/** Rendered one-shot card shell, stored when the card is registered. */
export interface DraftCardBody {
  title: string;
  summary: string;
  elements: object[];
  /** Index in `elements` where the settle result line is inserted. */
  statusAt: number;
}

export function draftCardBodyFromCard(card: object): DraftCardBody | undefined {
  if (!isRecord(card)) return undefined;
  const title = nestedString(card, ['header', 'title', 'content']);
  const summary = nestedString(card, ['config', 'summary', 'content']);
  const body = isRecord(card.body) ? card.body : undefined;
  const elements = body?.elements;
  if (!title || !summary || !Array.isArray(elements)) return undefined;
  const stripped = stripActionElements(elements);
  return {
    title,
    summary,
    elements: stripped.elements,
    statusAt: stripped.statusAt,
  };
}

export function renderSettledCard(body: DraftCardBody, status: string): object {
  const stripped = stripActionElements(body.elements);
  const elements = stripped.elements;
  const at = clampIndex(resolveStatusAt(stripped, body.statusAt) ?? elements.length, elements.length);
  elements.splice(at, 0, md(status));
  return card2({ title: body.title, summary: body.summary, elements });
}

export function parseDraftCardBody(raw: unknown): DraftCardBody | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.title !== 'string' || !raw.title) return undefined;
  if (typeof raw.summary !== 'string' || !raw.summary) return undefined;
  if (!Array.isArray(raw.elements) || raw.elements.some((element) => !isRecord(element))) return undefined;
  const stripped = stripActionElements(raw.elements);
  const statusAt = resolveStatusAt(stripped, raw.statusAt);
  if (statusAt === undefined || statusAt < 0 || statusAt > stripped.elements.length) return undefined;
  return {
    title: raw.title,
    summary: raw.summary,
    elements: stripped.elements,
    statusAt,
  };
}

export function cloneDraftCardBody(body: DraftCardBody): DraftCardBody {
  return {
    title: body.title,
    summary: body.summary,
    statusAt: body.statusAt,
    elements: body.elements.map((element) => cloneJson(element)),
  };
}

function stripActionElements(elements: readonly unknown[]): {
  elements: object[];
  statusAt: number;
  removed: number;
} {
  const kept: object[] = [];
  let statusAt = 0;
  let placed = false;
  let removed = 0;
  for (const element of elements) {
    if (isActionElement(element)) {
      removed += 1;
      if (!placed) {
        statusAt = kept.length;
        placed = true;
      }
      continue;
    }
    if (!isRecord(element)) continue;
    kept.push(cloneJson(element));
  }
  if (!placed) statusAt = kept.length;
  return { elements: kept, statusAt, removed };
}

function isActionElement(element: unknown): boolean {
  if (!isRecord(element)) return false;
  if (element.tag === 'button') return true;
  // Button rows, and forms. A Feishu form must contain a submit button, so once
  // the buttons are gone the form cannot stay on the settled card.
  if (element.tag === 'column_set' && containsButton(element)) return true;
  if (element.tag === 'form' && containsButton(element)) return true;
  return false;
}

function containsButton(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((entry) => containsButton(entry));
  if (!isRecord(node)) return false;
  if (node.tag === 'button') return true;
  return Object.values(node).some((value) => containsButton(value));
}

function resolveStatusAt(
  stripped: { statusAt: number; removed: number },
  stored: unknown,
): number | undefined {
  const statusAt = stripped.removed > 0 ? stripped.statusAt : stored;
  if (typeof statusAt !== 'number' || !Number.isInteger(statusAt)) return undefined;
  return statusAt;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0) return length;
  if (index > length) return length;
  return index;
}

function nestedString(root: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current ? current : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
