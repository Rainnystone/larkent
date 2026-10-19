import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bridgePackageRoot } from '../platform/package-root';

interface SkillContent { id: string; name: string; content: string; resource: string }
interface Plugin { id: string; version: string; description: string; skills: SkillContent[] }
export interface PluginDiagnostic { code: string; plugin?: string }

/** A deployment snapshot. Contents are read once, so a run cannot mix package versions. */
export class PluginCatalog {
  private constructor(private readonly plugins: Plugin[], readonly diagnostics: readonly PluginDiagnostic[]) {}

  static async load(roots: readonly string[]): Promise<PluginCatalog> {
    const plugins: Plugin[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const root of roots) {
      try {
        const base = await realpath(root);
        const manifest = JSON.parse(await readFile(await inside(base, '.codex-plugin/plugin.json'), 'utf8'));
        if (typeof manifest.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.name) || typeof manifest.version !== 'string' || !manifest.version
          || typeof manifest.description !== 'string' || !manifest.description.trim() || typeof manifest.skills !== 'string') {
          throw new Error('invalid-metadata');
        }
        const skillsRoot = await inside(base, manifest.skills);
        const skills: SkillContent[] = [];
        for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw new Error('invalid-skill-name');
          const resource = relative(base, join(skillsRoot, entry.name, 'SKILL.md')).split(sep).join('/');
          const content = await readFile(await inside(base, resource), 'utf8');
          skills.push({ id: `${manifest.name}:${entry.name}`, name: entry.name, content, resource });
        }
        if (!skills.length) throw new Error('missing-skills');
        plugins.push({ id: manifest.name, version: manifest.version, description: manifest.description, skills });
      } catch (err) {
        const code = err instanceof Error && ['invalid-metadata', 'invalid-skill-name', 'missing-skills', 'invalid-path'].includes(err.message)
          ? err.message : 'invalid-package';
        diagnostics.push({ code });
      }
    }
    const duplicates = new Set(plugins.filter(p => plugins.filter(other => other.id === p.id).length > 1).map(p => p.id));
    for (const id of duplicates) diagnostics.push({ code: 'plugin-conflict', plugin: id });
    return new PluginCatalog(plugins.filter(p => !duplicates.has(p.id)), diagnostics);
  }

  list() { return this.plugins.map(({ id, version, description }) => ({ id, version, description })); }
  inspect(id: string) {
    const plugin = this.plugins.find(p => p.id === id);
    return plugin ? { ...this.list().find(p => p.id === id)!, skills: plugin.skills.map(({ id, name, resource }) => ({ id, name, resource })) } : undefined;
  }
  read(id: string): { content: string; source: { plugin: string; version: string; resource: string } } | undefined {
    const matches = this.plugins.flatMap(plugin => plugin.skills.filter(skill => skill.id === id || skill.name === id)
      .map(skill => ({ content: skill.content, source: { plugin: plugin.id, version: plugin.version, resource: skill.resource } })));
    return matches.length === 1 ? matches[0] : undefined;
  }
}

async function inside(base: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('invalid-path');
  const target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('invalid-path');
  return target;
}

let builtin: Promise<PluginCatalog> | undefined;
export function builtinPluginCatalog(): Promise<PluginCatalog> {
  builtin ??= bridgePackageRoot().then(root => PluginCatalog.load([join(root, 'plugins/automation')]));
  return builtin;
}
