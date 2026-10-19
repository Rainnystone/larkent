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

it('discovers summaries, resolves qualified and unique skill names, and snapshots a consistent package version', async () => {
  const p = await packageFixture();
  const catalog = await PluginCatalog.load([p.root]);
  expect(catalog.list()).toEqual([{ id: 'synthetic', version: '1.0.0', description: 'A short synthetic summary' }]);
  expect(JSON.stringify(catalog.list())).not.toContain('sample');
  expect(catalog.inspect('synthetic')?.skills).toEqual([{ id: 'synthetic:sample', name: 'sample', resource: 'skills/sample/SKILL.md' }]);
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
  expect(catalog.diagnostics).toEqual([{ code: 'invalid-package' }, { code: 'plugin-conflict', plugin: 'duplicate' }]);
  expect(catalog.read('duplicate:sample')).toBeUndefined();
});

it('rejects a symlink escape and path traversal without reading the target into the catalog', async () => {
  const outside = await packageFixture('outside');
  const escaped = await packageFixture('escaped');
  await rm(escaped.skill);
  await symlink(outside.skill, escaped.skill, 'file');
  const catalog = await PluginCatalog.load([escaped.root]);
  expect(catalog.list()).toEqual([]);
  expect(catalog.diagnostics).toEqual([{ code: 'invalid-path' }]);
  expect(catalog.read('../outside')).toBeUndefined();
});
