import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PluginCatalog } from '../../../src/plugins/catalog';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function packageFixture(name = 'synthetic', version = '1.0.0') {
  const root = await mkdtemp(join(tmpdir(), 'plugin-catalog-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codex-plugin'));
  await mkdir(join(root, 'skills', 'sample'), { recursive: true });
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version, description: 'A short synthetic summary', skills: './skills' }));
  const skill = join(root, 'skills', 'sample', 'SKILL.md');
  await writeFile(skill, 'Synthetic full skill body');
  return { root, skill };
}

it('loads a Matt-like explicit list of nested skill directories through the catalog interface', async () => {
  const p = await packageFixture('engineering-bundle');
  await mkdir(join(p.root, 'skills/engineering/tdd'), { recursive: true });
  await writeFile(join(p.root, 'skills/engineering/tdd/SKILL.md'), 'Use one observed RED before GREEN.');
  await writeFile(join(p.root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'engineering-bundle', version: '1.3.1', description: 'Engineering workflows',
    skills: ['./skills/engineering/tdd'],
  }));
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.inspect('engineering-bundle')?.skills).toEqual([
    expect.objectContaining({ id: 'engineering-bundle:tdd', name: 'tdd', resource: 'skills/engineering/tdd/SKILL.md' }),
  ]);
  expect(catalog.read('tdd')?.content).toBe('Use one observed RED before GREEN.');
});

it('reads and locates declared resources with one version reference, and rejects stale references after a new-directory deployment', async () => {
  const p = await packageFixture('resources');
  await mkdir(join(p.root, 'skills/sample/references'));
  await writeFile(join(p.root, 'skills/sample/references/example.md'), 'Known fixture value: 42');
  const catalog = await PluginCatalog.load([p.root]);
  const skill = await catalog.resolveRead('resources:sample');
  expect(skill).toMatchObject({ code: 'content', data: { content: 'Synthetic full skill body', source: { reference: expect.any(String) } } });
  const reference = (skill.data as any).source.reference;
  const resource = await catalog.resolveRead('resources:sample', { resource: 'skills/sample/references/example.md', reference });
  expect(resource).toMatchObject({ code: 'content', data: { content: 'Known fixture value: 42', source: { reference, path: join(p.root, 'skills/sample/references/example.md') } } });
  expect(await catalog.resolveRead('resources:sample', { resource: '.codex-plugin/plugin.json' })).toMatchObject({ code: 'undeclared-resource' });
  const next = await packageFixture('resources', '2.0.0');
  await writeFile(next.skill, 'New version skill');
  const restarted = await PluginCatalog.load([next.root]);
  expect(await restarted.resolveRead('resources:sample', { reference })).toMatchObject({ code: 'stale-plugin-reference' });
  expect(await catalog.resolveRead('resources:sample', { reference })).toMatchObject({ data: { content: 'Synthetic full skill body' } });
  expect(await restarted.resolveRead('resources:sample')).toMatchObject({ data: { content: 'New version skill', source: { version: '2.0.0' } } });
});

it('diagnoses missing commands and unsupported required content while retaining independent skills', async () => {
  const p = await packageFixture('command-bundle');
  for (const name of ['dependent', 'hooked']) {
    await mkdir(join(p.root, 'skills', name));
    await writeFile(join(p.root, 'skills', name, 'SKILL.md'), `${name} instructions`);
  }
  await writeFile(join(p.root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'command-bundle', version: '1.0.0', description: 'Workflows with optional command access', skills: './skills',
    hooks: './hooks/hooks.json',
    larkent: { skills: {
      dependent: { requires: { commands: ['synthetic-command-that-does-not-exist'] } },
      hooked: { requires: { content: ['hooks'] } },
    } },
  }));
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.inspect('command-bundle')).toMatchObject({ availability: 'partial', skills: [
    { name: 'dependent', available: false, diagnostics: [{ code: 'missing-command', detail: 'synthetic-command-that-does-not-exist' }] },
    { name: 'hooked', available: false, diagnostics: [{ code: 'unsupported-required-content', detail: 'hooks' }] },
    { name: 'sample', available: true },
  ] });
  expect(await catalog.resolveRead('command-bundle:dependent')).toMatchObject({ code: 'skill-unavailable', data: { diagnostics: [{ code: 'missing-command' }] } });
  expect(await catalog.resolveRead('command-bundle:sample')).toMatchObject({ code: 'content' });
  expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported-content', plugin: 'command-bundle', detail: 'hooks' }));
});

it('returns every named plugin/skill alias candidate without scan-order precedence', async () => {
  const first = await packageFixture('first');
  const second = await packageFixture('second');
  for (const p of [first, second]) {
    const name = p === first ? 'first' : 'second';
    await writeFile(join(p.root, '.codex-plugin/plugin.json'), JSON.stringify({
      name, version: '1.0.0', description: 'Alias fixture', skills: './skills',
      larkent: { aliases: [name === 'first' ? 'engineering' : 'sample'], skills: { sample: { aliases: ['test-first'] } } },
    }));
  }
  const catalog = await PluginCatalog.load([second.root, first.root]);
  expect(catalog.resolveInspect('engineering')).toMatchObject({ code: 'plugin', data: { id: 'first' } });
  expect(await catalog.resolveRead('first:test-first')).toMatchObject({ code: 'content', data: { source: { plugin: 'first' } } });
  expect(await catalog.resolveRead('test-first')).toMatchObject({ code: 'skill-ambiguous', data: { candidates: [
    { id: 'first:sample' }, { id: 'second:sample' },
  ] } });
  expect(await catalog.resolveRead('sample')).toMatchObject({ code: 'skill-ambiguous', data: { candidates: [
    { id: 'first:sample' }, { id: 'second' }, { id: 'second:sample' },
  ] } });
  expect(await catalog.resolveRead('engineering')).toMatchObject({ code: 'plugin', data: { id: 'first' } });
});

it('refuses changed script bytes instead of locating a mixed version, and rejects resource escapes', async () => {
  const p = await packageFixture('scripts');
  await mkdir(join(p.root, 'skills/sample/scripts'));
  const script = join(p.root, 'skills/sample/scripts/value.mjs');
  await writeFile(script, 'console.log(42);');
  const catalog = await PluginCatalog.load([p.root]);
  expect(await catalog.resolveRead('scripts:sample', { resource: 'skills/sample/scripts/value.mjs' })).toMatchObject({
    code: 'content', data: { source: { type: 'script', path: script } },
  });
  for (const resource of ['../private.txt', '/etc/passwd', 'C:\\private.txt', 'skills/../../private.txt']) {
    expect(await catalog.resolveRead('scripts:sample', { resource })).toMatchObject({ code: 'invalid-path' });
  }
  await writeFile(script, 'console.log(99);');
  expect(await catalog.resolveRead('scripts:sample')).toMatchObject({ code: 'package-changed' });
  expect(await catalog.resolveRead('scripts:sample', { resource: 'skills/sample/scripts/value.mjs' })).toMatchObject({ code: 'package-changed' });
});

it.each([
  ['missing manifest', undefined, 'missing-manifest'],
  ['invalid JSON', '{', 'invalid-manifest'],
  ['invalid metadata', JSON.stringify({ name: 'Broken Name' }), 'invalid-metadata'],
  ['manifest traversal', JSON.stringify({ name: 'bad', version: '1.0.0', description: 'Bad', skills: '../outside' }), 'invalid-path'],
])('isolates %s with a precise installation diagnostic', async (_name, manifest, code) => {
  const p = await packageFixture('bad');
  const good = await packageFixture('good');
  const path = join(p.root, '.codex-plugin/plugin.json');
  if (manifest === undefined) await rm(path); else await writeFile(path, manifest);
  const catalog = await PluginCatalog.load([p.root, good.root]);
  expect(catalog.list().map(p => p.id)).toEqual(['good']);
  expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code, root: p.root }));
});

it('rejects a symlink to an undeclared package directory even when it stays inside the package', async () => {
  const p = await packageFixture();
  await writeFile(join(p.root, 'private.txt'), 'Not declared content');
  await symlink(join(p.root, 'private.txt'), join(p.root, 'skills/sample/escape.txt'), 'file');
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-path' }));
  expect(await catalog.resolveRead('sample', { resource: 'skills/sample/escape.txt' })).not.toMatchObject({ code: 'content' });
});

it('loads explicitly declared package resources and identifies a fixed source revision without a release version', async () => {
  const p = await packageFixture('pinned');
  await mkdir(join(p.root, 'references'));
  await writeFile(join(p.root, 'references/shared.md'), 'Pinned shared reference');
  await writeFile(join(p.root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'pinned', description: 'Pinned fixture', skills: './skills',
    larkent: { revision: '1234567890abcdef1234567890abcdef12345678', resources: ['./references'] },
  }));
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.list()).toContainEqual(expect.objectContaining({ id: 'pinned', version: '1234567890abcdef1234567890abcdef12345678' }));
  expect(await catalog.resolveRead('pinned:sample', { resource: 'references/shared.md' })).toMatchObject({ code: 'content', data: { content: 'Pinned shared reference' } });
});

it('diagnoses duplicate skill identifiers and keeps an independent capability readable', async () => {
  const p = await packageFixture('duplicates');
  for (const name of ['a/shared', 'b/shared']) {
    await mkdir(join(p.root, 'skills', name), { recursive: true });
    await writeFile(join(p.root, 'skills', name, 'SKILL.md'), name);
  }
  await writeFile(join(p.root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'duplicates', version: '1.0.0', description: 'Duplicate skill fixture',
    skills: ['./skills/a/shared', './skills/b/shared', './skills/sample'],
  }));
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: 'skill-conflict', plugin: 'duplicates', skill: 'shared' }));
  expect(catalog.inspect('duplicates')?.availability).toBe('partial');
  expect(await catalog.resolveRead('duplicates:shared')).toMatchObject({ code: 'skill-ambiguous', data: { candidates: [
    { resource: 'skills/a/shared/SKILL.md' }, { resource: 'skills/b/shared/SKILL.md' },
  ] } });
  expect(await catalog.resolveRead('duplicates:sample')).toMatchObject({ code: 'content' });
});

it('rejects newly added declared files rather than mixing an old script with new imported resources', async () => {
  const p = await packageFixture('immutable');
  const catalog = await PluginCatalog.load([p.root]);
  await writeFile(join(p.root, 'skills/sample/late-import.json'), '{"new":true}');
  expect(await catalog.resolveRead('immutable:sample')).toMatchObject({ code: 'package-changed' });
});

it('discovers summaries, resolves qualified and unique skill names, and snapshots a consistent package version', async () => {
  const p = await packageFixture();
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.list()).toEqual([{ id: 'synthetic', version: '1.0.0', description: 'A short synthetic summary' }]);
  expect(JSON.stringify(catalog.list())).not.toContain('sample');
  expect(catalog.inspect('synthetic')?.skills).toEqual([expect.objectContaining({ id: 'synthetic:sample', name: 'sample', resource: 'skills/sample/SKILL.md', available: true })]);
  expect(catalog.read('sample')).toMatchObject({ content: 'Synthetic full skill body', source: { plugin: 'synthetic', version: '1.0.0' } });
  await writeFile(p.skill, 'Updated skill body');
  expect(catalog.read('synthetic:sample')?.content).toBe('Synthetic full skill body');
  expect((await PluginCatalog.load([p.root])).read('sample')?.content).toBe('Updated skill body');
});

it('isolates broken packages and rejects duplicate IDs without scan-order overrides', async () => {
  const good = await packageFixture('good');
  const first = await packageFixture('duplicate');
  const second = await packageFixture('duplicate', '2.0.0');
  const catalog = await PluginCatalog.load([first.root, '/synthetic-does-not-exist', good.root, second.root]);
  expect(catalog.list().map(p => p.id)).toEqual(['good']);
  expect(catalog.diagnostics).toEqual([{ code: 'invalid-package', root: '/synthetic-does-not-exist' }, { code: 'plugin-conflict', plugin: 'duplicate' }]);
  expect(catalog.read('duplicate:sample')).toBeUndefined();
});

it('rejects a symlink escape and path traversal without reading the target into the catalog', async () => {
  const outside = await packageFixture('outside');
  const escaped = await packageFixture('escaped');
  await rm(escaped.skill);
  await symlink(outside.skill, escaped.skill, 'file');
  const catalog = await PluginCatalog.load([escaped.root]);
  expect(catalog.list()).toEqual([]);
  expect(catalog.diagnostics).toEqual([{ code: 'invalid-path', root: escaped.root }]);
  expect(catalog.read('../outside')).toBeUndefined();
});
