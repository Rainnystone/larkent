import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bridgePackageRoot } from '../platform/package-root';
import { resolveExecutablePath } from '../platform/executable';

interface SkillContent { id: string; name: string; aliases: string[]; content: string; resource: string; available: boolean; diagnostics: PluginDiagnostic[] }
interface Resource { content: Buffer; path: string }
interface Plugin { id: string; aliases: string[]; version: string; description: string; skills: SkillContent[]; files: Map<string, Resource>; reference: string; base: string; manifest: string; contentRoots: string[]; scopes: string[] }
export interface CatalogResult { code: string; data?: unknown }
export interface PluginDiagnostic { code: string; plugin?: string; detail?: string; skill?: string; root?: string }

/** A deployment snapshot. Contents are read once, so a run cannot mix package versions. */
export class PluginCatalog {
  private constructor(private readonly plugins: Plugin[], readonly diagnostics: readonly PluginDiagnostic[]) {}

  static async deployment(rootDir: string): Promise<PluginCatalog> {
    const configPath = join(rootDir, 'plugins.json');
    const roots = [join(await bridgePackageRoot(), 'plugins/automation')];
    const diagnostics: PluginDiagnostic[] = [];
    try {
      const config = object(JSON.parse(await readFile(configPath, 'utf8')));
      if (config.schemaVersion !== 1 || Object.keys(config).some(key => !['schemaVersion', 'packages'].includes(key))
        || !Array.isArray(config.packages) || !config.packages.every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('invalid-installation-config');
      roots.push(...config.packages);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ code: 'invalid-installation-config', root: configPath });
    }
    const catalog = await PluginCatalog.load(roots);
    return new PluginCatalog(catalog.plugins, [...diagnostics, ...catalog.diagnostics]);
  }

  static async load(roots: readonly string[]): Promise<PluginCatalog> {
    const plugins: Plugin[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const root of roots) {
      try {
        const base = await realpath(root);
        let manifestText: string;
        try { manifestText = await readFile(await inside(base, '.codex-plugin/plugin.json'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('missing-manifest'); throw error; }
        let manifest: Record<string, unknown>;
        try { manifest = object(JSON.parse(manifestText)); }
        catch (error) { if (error instanceof SyntaxError) throw new Error('invalid-manifest'); throw error; }
        const metadata = extension(manifest.larkent);
        const version = manifest.version ?? metadata.revision;
        if (typeof manifest.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.name) || typeof version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)
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
        const unsupported = ['mcpServers', 'hooks', 'apps', 'agents'].filter(key => manifest[key] !== undefined);
        for (const detail of unsupported) diagnostics.push({ code: 'unsupported-content', plugin: manifest.name, detail });
        for (const directory of directories) {
          const name = basename(directory);
          if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid-skill-name');
          const resource = relative(base, join(directory, 'SKILL.md')).split(sep).join('/');
          const content = await readFile(await inside(base, resource), 'utf8');
          const problems = await requirements([...metadata.requires, ...(metadata.skills[name]?.requires ?? [])]);
          skills.push({ id: `${manifest.name}:${name}`, name, aliases: metadata.skills[name]?.aliases ?? [], content, resource, available: !problems.length, diagnostics: problems });
        }
        if (!skills.length) throw new Error('missing-skills');
        for (const name of new Set(skills.filter(s => skills.filter(other => other.name === s.name).length > 1).map(s => s.name))) {
          const diagnostic = { code: 'skill-conflict', plugin: manifest.name, skill: name };
          diagnostics.push(diagnostic);
          for (const skill of skills.filter(s => s.name === name)) { skill.available = false; skill.diagnostics.push(diagnostic); }
        }
        const files = new Map<string, Resource>();
        const declared = [...directories, ...await Promise.all(metadata.resources.map(path => inside(base, path)))];
        const scopes = await Promise.all(declared.map(directory => realpath(directory)));
        const contentRoots = declared.map(directory => relative(base, directory).split(sep).join('/'));
        for (const directory of contentRoots) await snapshot(base, directory, files, scopes);
        const hash = createHash('sha256').update(base).update(JSON.stringify(manifest));
        for (const [resource, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(resource).update(file.content);
        plugins.push({ id: manifest.name, aliases: metadata.aliases, version, description: manifest.description, skills, files, reference: hash.digest('hex'), base, manifest: manifestText, contentRoots, scopes });
      } catch (err) {
        const code = err instanceof Error && ['missing-manifest', 'invalid-manifest', 'invalid-metadata', 'invalid-skill-name', 'missing-skills', 'invalid-path'].includes(err.message)
          ? err.message : 'invalid-package';
        diagnostics.push({ code, root });
      }
    }
    const duplicates = new Set(plugins.filter(p => plugins.filter(other => other.id === p.id).length > 1).map(p => p.id));
    for (const id of duplicates) diagnostics.push({ code: 'plugin-conflict', plugin: id });
    return new PluginCatalog(plugins.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)), diagnostics);
  }

  list() { return this.plugins.filter(p => !this.conflicted(p.id)).map(({ id, version, description, skills }) => ({ id, version, description,
    ...(!skills.every(skill => skill.available) ? { availability: skills.some(skill => skill.available) ? 'partial' : 'unavailable' } : {}),
  })); }
  inspect(id: string) {
    const matches = this.plugins.filter(p => p.id === id || p.aliases.includes(id));
    const plugin = matches.length === 1 ? matches[0] : undefined;
    return plugin ? { ...this.list().find(p => p.id === plugin.id)!,
      availability: plugin.skills.every(s => s.available) ? 'available' : plugin.skills.some(s => s.available) ? 'partial' : 'unavailable',
      skills: plugin.skills.map(({ id, name, aliases, resource, available, diagnostics }) => ({ id, name, aliases, resource, available, diagnostics })) } : undefined;
  }
  private conflicted(id: string): boolean { return this.plugins.filter(p => p.id === id).length > 1; }
  /** Business bindings use canonical IDs; discovery aliases cannot shadow them. */
  async isAvailable(id: string): Promise<boolean> {
    const matches = this.plugins.filter(p => p.id === id);
    return matches.length === 1 && matches[0]!.skills.some(s => s.available) && await unchanged(matches[0]!);
  }
  resolveInspect(id: string): CatalogResult {
    const matches = this.plugins.filter(p => p.id === id || p.aliases.includes(id));
    if (matches.length > 1) return { code: 'plugin-ambiguous', data: { candidates: matches.map(p => ({ id: p.id, version: p.version, reference: p.reference })) } };
    const plugin = this.inspect(id);
    return plugin ? { code: 'plugin', data: plugin } : { code: 'plugin-not-found' };
  }
  read(id: string): { content: string; source: { plugin: string; version: string; resource: string } } | undefined {
    const matches = this.plugins.filter(p => !this.conflicted(p.id)).flatMap(plugin => plugin.skills.filter(skill => skill.available && (skill.id === id || skill.name === id))
      .map(skill => ({ content: skill.content, source: { plugin: plugin.id, version: plugin.version, resource: skill.resource } })));
    return matches.length === 1 ? matches[0] : undefined;
  }

  async resolveRead(id: string, options: { resource?: string; reference?: string } = {}): Promise<CatalogResult> {
    const matches: Array<{ plugin: Plugin; skill?: SkillContent }> = this.plugins.flatMap(plugin => [
      ...(plugin.id === id || plugin.aliases.includes(id) ? [{ plugin }] : []),
      ...plugin.skills.filter(skill => [skill.id, skill.name, ...skill.aliases,
        ...[plugin.id, ...plugin.aliases].flatMap(name => [skill.name, ...skill.aliases].map(skillName => `${name}:${skillName}`))].includes(id))
        .map(skill => ({ plugin, skill })),
    ]);
    if (matches.length > 1) return { code: 'skill-ambiguous', data: { candidates: matches.map(({ plugin, skill }) => ({ id: skill?.id ?? plugin.id, version: plugin.version, reference: plugin.reference, ...(skill ? { resource: skill.resource } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)) } };
    if (!matches.length) return { code: 'skill-not-found-or-ambiguous' };
    const { plugin, skill } = matches[0]!;
    if (options.reference !== undefined && options.reference !== plugin.reference) return { code: 'stale-plugin-reference' };
    if (!skill) return this.resolveInspect(id);
    if (!skill.available) return { code: 'skill-unavailable', data: { diagnostics: skill.diagnostics } };
    const resource = options.resource ?? skill.resource;
    if (!validPath(resource)) return { code: 'invalid-path' };
    const file = plugin.files.get(resource);
    if (!file) return { code: 'undeclared-resource' };
    if (!await unchanged(plugin)) return { code: 'package-changed' };
    return { code: 'content', data: {
      content: file.content.toString('utf8'),
      source: { plugin: plugin.id, version: plugin.version, reference: plugin.reference, resource, path: file.path,
        type: resource === skill.resource ? 'skill' : resource.split('/').includes('scripts') ? 'script' : 'resource' },
      resources: [...plugin.files.keys()].sort(),
    } };
  }
}

async function unchanged(plugin: Plugin): Promise<boolean> {
  try {
    if (await readFile(await inside(plugin.base, '.codex-plugin/plugin.json'), 'utf8') !== plugin.manifest) return false;
    const current = new Map<string, Resource>();
    for (const root of plugin.contentRoots) await snapshot(plugin.base, root, current, plugin.scopes);
    if (current.size !== plugin.files.size) return false;
    for (const [resource, file] of plugin.files) {
      const actual = current.get(resource);
      if (!actual || actual.path !== file.path || !actual.content.equals(file.content)) return false;
    }
    return true;
  } catch { return false; }
}

interface Requirement { type: 'command' | 'content'; value: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-metadata');
  return value as Record<string, unknown>;
}
interface Requirements { requires: Requirement[]; aliases: string[] }
function aliases(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && /^[a-z][a-z0-9-]*$/.test(item))) throw new Error('invalid-metadata');
  return [...new Set(value)];
}
function extension(value: unknown): Requirements & { skills: Record<string, Requirements>; resources: string[]; revision?: string } {
  if (value === undefined) return { requires: [], aliases: [], skills: {}, resources: [] };
  const meta = object(value);
  if (Object.keys(meta).some(key => !['aliases', 'requires', 'skills', 'resources', 'revision'].includes(key))) throw new Error('invalid-metadata');
  if (meta.revision !== undefined && (typeof meta.revision !== 'string' || !/^[a-f0-9]{40}$/.test(meta.revision))) throw new Error('invalid-metadata');
  if (meta.resources !== undefined && (!Array.isArray(meta.resources) || !meta.resources.every(path => typeof path === 'string' && validPath(path)))) throw new Error('invalid-path');
  const skills: Record<string, Requirements> = {};
  if (meta.skills !== undefined) for (const [name, value] of Object.entries(object(meta.skills))) {
    const skill = object(value);
    skills[name] = { requires: parseRequirements(skill.requires), aliases: aliases(skill.aliases) };
  }
  return { requires: parseRequirements(meta.requires), aliases: aliases(meta.aliases), skills, resources: meta.resources as string[] ?? [], revision: meta.revision as string | undefined };
}
function parseRequirements(value: unknown): Requirement[] {
  if (value === undefined) return [];
  const input = object(value);
  if (Object.keys(input).some(key => !['commands', 'content'].includes(key))) throw new Error('invalid-metadata');
  const result: Requirement[] = [];
  for (const key of ['commands', 'content'] as const) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(item => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(item))) throw new Error('invalid-metadata');
    for (const value of input[key] as string[]) result.push({ type: key === 'commands' ? 'command' : 'content', value });
  }
  return result;
}
async function requirements(input: Requirement[]): Promise<PluginDiagnostic[]> {
  const result: PluginDiagnostic[] = [];
  for (const requirement of input) {
    if (requirement.type === 'content') {
      if (!['skill', 'resource', 'script', 'command'].includes(requirement.value)) result.push({ code: 'unsupported-required-content', detail: requirement.value });
    } else {
      try { if (!(await stat(await resolveExecutablePath(requirement.value))).isFile()) throw new Error('not-file'); }
      catch { result.push({ code: 'missing-command', detail: requirement.value }); }
    }
  }
  return result;
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

async function snapshot(base: string, path: string, files: Map<string, Resource>, scopes: string[], ancestors: string[] = []): Promise<void> {
  const directory = await inside(base, path);
  if (!scopes.some(scope => contained(scope, directory))) throw new Error('invalid-path');
  const info = await stat(directory);
  if (info.isFile()) { files.set(path.split(sep).join('/'), { content: await readFile(directory), path: directory }); return; }
  if (!info.isDirectory()) throw new Error('invalid-path');
  if (ancestors.includes(directory)) throw new Error('invalid-path');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const resource = join(path, entry.name).split(sep).join('/');
    const target = await inside(base, resource);
    if (!scopes.some(scope => contained(scope, target))) throw new Error('invalid-path');
    const info = await stat(target);
    if (info.isDirectory()) await snapshot(base, resource, files, scopes, [...ancestors, directory]);
    else if (info.isFile()) {
      const content = await readFile(target);
      files.set(resource, { content, path: target });
    } else throw new Error('invalid-path');
  }
}

function contained(base: string, target: string): boolean {
  const path = relative(base, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

let builtin: Promise<PluginCatalog> | undefined;
export function builtinPluginCatalog(): Promise<PluginCatalog> {
  builtin ??= bridgePackageRoot().then(root => PluginCatalog.load([join(root, 'plugins/automation')]));
  return builtin;
}

/** Called once at profile startup; the returned deployment snapshot has no hot reload. */
export function deploymentPluginCatalog(rootDir: string): Promise<PluginCatalog> {
  return PluginCatalog.deployment(resolve(rootDir));
}
