import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS } from '../../src/agent/registry.js';
import { getBackfillPreferences, DEFAULT_BACKFILL_PREFERENCES } from '../../src/config/schema.js';
import { loadRootConfig } from '../../src/config/profile-store.js';
import { REQUIRED_BACKFILL_EVENTS } from '../../src/observability/events.js';

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const BACKFILL_IMPL_FILES = [
  'src/bot/backfill.ts',
  'src/bot/backfill-ledger.ts',
  'src/bot/keepalive.ts',
] as const;

const NAMED_BOTS = ['grokbot', 'Grok Bot', 'larkent-for-grokbot', 'SpaceXAI'];
const KIND_LITERAL = new RegExp(
  `['"\`](${AGENT_KINDS.join('|')})['"\`]`,
);
const ID_LITERAL = /['"`](?:oc_|ou_|cli_)[A-Za-z0-9]{2,}['"`]/;

describe('backfill static contracts', () => {
  it('emits every REQUIRED_BACKFILL_EVENTS name in the bot layer', () => {
    const botLayer = [
      'src/bot/backfill.ts',
      'src/bot/backfill-ledger.ts',
      'src/bot/keepalive.ts',
      'src/bot/channel.ts',
      'src/commands/index.ts',
    ].map(read).join('\n');

    const missing = REQUIRED_BACKFILL_EVENTS.filter((name) => !emittedInSource(botLayer, name));
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it('keeps REQUIRED_BACKFILL_EVENTS aligned with spec §13', () => {
    const spec = read('docs/specs/wake-up-backfill.md');
    const section = spec.split('## 13. Observability')[1]?.split('\n## 14.')[0] ?? '';
    expect(section.length).toBeGreaterThan(0);

    const fromSpec = eventsFromSpecSection(section);
    expect([...fromSpec].sort()).toEqual([...REQUIRED_BACKFILL_EVENTS].sort());
  });

  it('keeps ledger / watermark / backfill / defaults free of identifiers', () => {
    const schema = read('src/config/schema.ts');
    const backfillSchema = extractBackfillSchema(schema);
    const sources = [
      ...BACKFILL_IMPL_FILES.map((file) => ({ file, source: stripComments(read(file)) })),
      { file: 'src/config/schema.ts#backfill', source: stripComments(backfillSchema) },
    ];

    for (const { file, source } of sources) {
      expect(source, file).not.toMatch(KIND_LITERAL);
      expect(source, file).not.toMatch(ID_LITERAL);
      for (const name of NAMED_BOTS) {
        expect(source, `${file} ${name}`).not.toContain(name);
      }
    }
  });

  it('uses byte-identical backfill defaults for every agent-kind fixture', async () => {
    const fixtureRoot = join(root, 'tests/fixtures/profiles');
    const seen = new Set<string>();
    const encoded = JSON.stringify(DEFAULT_BACKFILL_PREFERENCES);

    for (const dir of readdirSync(fixtureRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const loaded = await loadRootConfig(join(fixtureRoot, dir.name, 'config.json'));
      expect(loaded, dir.name).toBeDefined();
      for (const profile of Object.values(loaded!.profiles)) {
        seen.add(profile.agentKind);
        expect(JSON.stringify(getBackfillPreferences(profile))).toBe(encoded);
      }
    }

    expect([...seen].sort()).toEqual([...AGENT_KINDS].sort());
  });
});

function emittedInSource(source: string, fullName: string): boolean {
  if (source.includes(`'${fullName}'`) || source.includes(`"${fullName}"`)) return true;
  const dot = fullName.indexOf('.');
  if (dot < 0) return false;
  const component = fullName.slice(0, dot);
  const event = fullName.slice(dot + 1);
  const call = new RegExp(`['"]${escapeRegExp(component)}['"]\\s*,\\s*['"]${escapeRegExp(event)}['"]`);
  return call.test(source);
}

function eventsFromSpecSection(section: string): string[] {
  const names = new Set<string>();
  for (const match of section.matchAll(/`([a-z][a-z0-9.*-]*)`/g)) {
    let name = match[1];
    if (name.includes('*')) continue;
    if (name.startsWith('skip-') && !name.includes('.')) name = `backfill.${name}`;
    if (name.startsWith('backfill.') || name === 'intake.skip-duplicate') names.add(name);
  }
  return [...names];
}

function extractBackfillSchema(schema: string): string {
  const defaultsStart = schema.indexOf('export interface BackfillPreferences');
  const defaultsEnd = schema.indexOf('export interface AppAccess');
  const fnStart = schema.indexOf('export function normalizeBackfillPreferences');
  expect(defaultsStart).toBeGreaterThan(-1);
  expect(defaultsEnd).toBeGreaterThan(defaultsStart);
  expect(fnStart).toBeGreaterThan(-1);
  return `${schema.slice(defaultsStart, defaultsEnd)}\n${schema.slice(fnStart)}`;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
