import { expect } from 'vitest';

export function expectSettledKeepsBody(input: {
  settledJson: string;
  originalJson: string;
  status: string;
  absent?: string[];
}): void {
  const settled = asCard(JSON.parse(input.settledJson) as unknown);
  const original = asCard(JSON.parse(input.originalJson) as unknown);
  expect(headerTitle(settled)).toBe(headerTitle(original));
  expect(summaryText(settled)).toBe(summaryText(original));

  const originalMarkdown = markdownContents(original);
  const settledMarkdown = markdownContents(settled);
  expect(originalMarkdown.length).toBeGreaterThan(0);
  expect(settledMarkdown.slice(0, originalMarkdown.length)).toEqual(originalMarkdown);
  expect(settledMarkdown.filter((text) => text === input.status)).toEqual([input.status]);
  expect(settledMarkdown.at(-1)).toBe(input.status);

  expect(input.settledJson).not.toContain('"tag":"button"');
  expect(input.settledJson).not.toContain('"disabled"');
  expect(input.settledJson).not.toContain('"tag":"column_set"');
  expect(input.settledJson).not.toContain('"tag":"form"');
  if (input.originalJson.includes('"tag":"hr"')) {
    expect(input.settledJson).toContain('"tag":"hr"');
  }
  for (const banned of input.absent ?? []) {
    expect(input.settledJson).not.toContain(banned);
  }
}

function asCard(value: unknown): Record<string, unknown> {
  if (isRecord(value) && isRecord(value.card)) return value.card;
  if (isRecord(value)) return value;
  throw new Error('expected a card object');
}

function headerTitle(card: Record<string, unknown>): string {
  const header = asRecord(card.header);
  const title = asRecord(header?.title);
  if (typeof title?.content !== 'string') throw new Error('expected a card title');
  return title.content;
}

function summaryText(card: Record<string, unknown>): string {
  const config = asRecord(card.config);
  const summary = asRecord(config?.summary);
  if (typeof summary?.content !== 'string') throw new Error('expected a card summary');
  return summary.content;
}

function markdownContents(card: Record<string, unknown>): string[] {
  const body = asRecord(card.body);
  const elements = body?.elements;
  if (!Array.isArray(elements)) return [];
  const texts: string[] = [];
  collectMarkdown(elements, texts);
  return texts;
}

function collectMarkdown(nodes: unknown[], texts: string[]): void {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (node.tag === 'markdown' && typeof node.content === 'string') texts.push(node.content);
    if (Array.isArray(node.elements)) collectMarkdown(node.elements, texts);
    if (Array.isArray(node.columns)) collectMarkdown(node.columns, texts);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
