import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bridgePackageRoot } from '../platform/package-root';

interface SkillContent { id: string; name: string; content: string; resource: string }
interface Resource { content: Buffer; path: string }
interface Plugin { id: string; version: string; description: string; skills: SkillContent[]; files: Map<string, Resource>; reference: string }
export interface CatalogResult { code: string; data?: unknown }
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
          || typeof manifest.description !== 'string' || !manifest.description.trim()
          || !(typeof manifest.skills === 'string' || Array.isArray(manifest.skills) && manifest.skills.length && manifest.skills.every((p: unknown) => typeof p === 'string'))) {
          throw new Error('invalid-metadata');
        }
        const directories: string[] = [];
        if (Array.isArray(manifest.skills)) {
          for (const path of manifest.skills) directories.push(await inside(base, path));
        } else {
          const skillsRoot = await inside(base, manifest.skills);
          for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() || entry.isSymbolicLink()) directories.push(join(skillsRoot, entry.name));
          }
        }
        const skills: SkillContent[] = [];
        for (const directory of directories) {
          const name = basename(directory);
          if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid-skill-name');
          const resource = relative(base, join(directory, 'SKILL.md')).split(sep).join('/');
          const content = await readFile(await inside(base, resource), 'utf8');
          skills.push({ id: `${manifest.name}:${name}`, name, content, resource });
        }
        if (!skills.length) throw new Error('missing-skills');
        const files = new Map<string, Resource>();
        for (const directory of directories) await snapshot(base, relative(base, directory), files);
        const hash = createHash('sha256').update(base).update(JSON.stringify(manifest));
        for (const [resource, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(resource).update(file.content);
        plugins.push({ id: manifest.name, version: manifest.version, description: manifest.description, skills, files, reference: hash.digest('hex') });
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

  async resolveRead(id: string, options: { resource?: string; reference?: string } = {}): Promise<CatalogResult> {
    const matches = this.plugins.flatMap(plugin => plugin.skills.filter(skill => skill.id === id || skill.name === id)
      .map(skill => ({ plugin, skill })));
    if (matches.length !== 1) return { code: 'skill-not-found-or-ambiguous' };
    const { plugin, skill } = matches[0]!;
    if (options.reference !== undefined && options.reference !== plugin.reference) return { code: 'stale-plugin-reference' };
    const resource = options.resource ?? skill.resource;
    if (!validPath(resource)) return { code: 'invalid-path' };
    const file = plugin.files.get(resource);
    if (!file) return { code: 'undeclared-resource' };
    return { code: 'content', data: {
      content: file.content.toString('utf8'),
      source: { plugin: plugin.id, version: plugin.version, reference: plugin.reference, resource, path: file.path },
      resources: [...plugin.files.keys()].sort(),
    } };
  }
}

function validPath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !/^[a-z]:/i.test(path) && !path.includes('\\') && !path.split('/').includes('..');
}

async function inside(base: string, path: string): Promise<string> {
  if (!validPath(path)) throw new Error('invalid-path');
  const target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('invalid-path');
  return target;
}

async function snapshot(base: string, path: string, files: Map<string, Resource>, ancestors: string[] = []): Promise<void> {
  const directory = await inside(base, path);
  if (ancestors.includes(directory)) throw new Error('invalid-path');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const resource = join(path, entry.name).split(sep).join('/');
    const target = await inside(base, resource);
    if (entry.isDirectory()) await snapshot(base, resource, files, [...ancestors, directory]);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const content = await readFile(target);
      files.set(resource, { content, path: target });
    } else throw new Error('invalid-path');
  }
}

let builtin: Promise<PluginCatalog> | undefined;
export function builtinPluginCatalog(): Promise<PluginCatalog> {
  builtin ??= bridgePackageRoot().then(root => PluginCatalog.load([join(root, 'plugins/automation')]));
  return builtin;
}
