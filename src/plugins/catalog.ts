import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bridgePackageRoot } from '../platform/package-root';
import { resolveExecutablePath } from '../platform/executable';

interface SkillContent { id: string; name: string; aliases: string[]; resource: string; available: boolean; diagnostics: PluginDiagnostic[] }
interface Resource { content: Buffer; path: string }
interface Plugin { id: string; aliases: string[]; version: string; description: string; diagnostics: PluginDiagnostic[]; skills: SkillContent[]; files: Map<string, Resource>; reference: string; base: string; manifest: string; contentRoots: string[]; scopes: string[]; directories: string[] }
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
        let base: string;
        try {
          base = await realpath(root);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('missing-root');
          throw error;
        }
        if (!(await stat(base)).isDirectory()) throw new Error('invalid-root');
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
        const unsupported = ['mcpServers', 'hooks', 'apps', 'agents'].filter(key => manifest[key] !== undefined)
          .map(detail => ({ code: 'unsupported-content', plugin: manifest.name as string, detail }));
        diagnostics.push(...unsupported);
        for (const directory of directories) {
          const name = basename(directory);
          if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid-skill-name');
          const resource = relative(base, join(directory, 'SKILL.md')).split(sep).join('/');
          const problems = await requirements([...metadata.requires, ...(metadata.skills[name]?.requires ?? [])]);
          skills.push({ id: `${manifest.name}:${name}`, name, aliases: metadata.skills[name]?.aliases ?? [], resource, available: !problems.length, diagnostics: problems });
        }
        if (!skills.length) throw new Error('missing-skills');
        if (Object.keys(metadata.skills).some(name => !skills.some(skill => skill.name === name))) throw new Error('invalid-metadata');
        for (const name of new Set(skills.filter(s => skills.filter(other => other.name === s.name).length > 1).map(s => s.name))) {
          const diagnostic = { code: 'skill-conflict', plugin: manifest.name, skill: name };
          diagnostics.push(diagnostic);
          for (const skill of skills.filter(s => s.name === name)) { skill.available = false; skill.diagnostics.push(diagnostic); }
        }
        const files = new Map<string, Resource>();
        const declared = [...(Array.isArray(manifest.skills) ? manifest.skills as string[] : [manifest.skills]), ...metadata.resources];
        const scopes = declared.map(path => resolve(base, path));
        const contentRoots = scopes.map(directory => relative(base, directory).split(sep).join('/') || '.');
        const directoryNames = new Set<string>();
        for (const directory of contentRoots) await snapshot(base, directory, files, scopes, [], directoryNames);
        if (skills.some(skill => !files.has(skill.resource))) throw new Error('missing-skill-content');
        const hash = createHash('sha256').update(JSON.stringify([base, manifest, [...directoryNames].sort()]));
        for (const [resource, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
          hash.update(JSON.stringify([resource, file.path, createHash('sha256').update(file.content).digest('hex')]));
        }
        plugins.push({ id: manifest.name, aliases: metadata.aliases, version, description: manifest.description, diagnostics: unsupported, skills, files, reference: hash.digest('hex'), base, manifest: manifestText, contentRoots, scopes, directories: [...directoryNames].sort() });
      } catch (err) {
        const code = err instanceof Error && ['missing-root', 'invalid-root', 'missing-manifest', 'invalid-manifest', 'invalid-metadata', 'invalid-skill-name', 'missing-skills', 'missing-skill-content', 'invalid-path'].includes(err.message)
          ? err.message : 'invalid-package';
        diagnostics.push({ code, root });
      }
    }
    const duplicates = new Set(plugins.filter(p => plugins.filter(other => other.id === p.id).length > 1).map(p => p.id));
    for (const id of duplicates) diagnostics.push({ code: 'plugin-conflict', plugin: id });
    return new PluginCatalog(plugins.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)), diagnostics);
  }

  async list() {
    return Promise.all(this.plugins.map(async plugin => {
      const { id, version, description, availability, diagnostics } = await this.describe(plugin);
      return { id, version, description, ...(this.conflicted(id) ? { root: plugin.base, reference: plugin.reference } : {}),
        ...(availability === 'available' ? {} : { availability }), ...(diagnostics.length ? { diagnostics } : {}) };
    }));
  }
  async inspect(id: string, options: { reference?: string } = {}) {
    const matches = this.pluginMatches(id, options.reference);
    return matches.length === 1 ? this.describe(matches[0]!) : undefined;
  }
  private pluginMatches(id: string, reference?: string): Plugin[] {
    return this.plugins.filter(p => (p.id === id || p.aliases.includes(id)) && (reference === undefined || p.reference === reference));
  }
  private async describe(plugin: Plugin) {
    const changes: PluginDiagnostic[] = await unchanged(plugin) ? [] : [{ code: 'package-changed' }];
    const diagnostics = [...plugin.diagnostics, ...(this.conflicted(plugin.id) ? [{ code: 'plugin-conflict', plugin: plugin.id }] : []), ...changes];
    const skills = plugin.skills.map(({ id, name, aliases, resource, available, diagnostics: problems }) => ({
      id, name, aliases, resource, available: available && !changes.length, diagnostics: [...problems, ...changes],
    }));
    const status = availability(skills);
    return { id: plugin.id, version: plugin.version, root: plugin.base, description: plugin.description, reference: plugin.reference,
      availability: status === 'available' && diagnostics.length ? 'partial' as const : status, diagnostics, skills };
  }
  private conflicted(id: string): boolean { return this.plugins.filter(p => p.id === id).length > 1; }
  /** Business bindings use canonical IDs; discovery aliases cannot shadow them. */
  async isAvailable(id: string): Promise<boolean> {
    const matches = this.plugins.filter(p => p.id === id);
    return matches.length === 1 && matches[0]!.skills.some(s => s.available) && await unchanged(matches[0]!);
  }
  async resolveInspect(id: string, options: { reference?: string } = {}): Promise<CatalogResult> {
    const matches = this.pluginMatches(id, options.reference);
    if (!matches.length && options.reference !== undefined) return { code: 'stale-plugin-reference' };
    if (matches.length > 1) return { code: 'plugin-ambiguous', data: { candidates: matches.map(p => ({ id: p.id, version: p.version, root: p.base, reference: p.reference })) } };
    const plugin = matches.length === 1 ? await this.describe(matches[0]!) : undefined;
    return plugin ? { code: 'plugin', data: plugin } : { code: 'plugin-not-found' };
  }

  async resolveRead(id: string, options: { resource?: string; reference?: string } = {}): Promise<CatalogResult> {
    const matches: Array<{ plugin: Plugin; skill?: SkillContent }> = this.plugins.flatMap(plugin => [
      ...(plugin.id === id || plugin.aliases.includes(id) ? [{ plugin }] : []),
      ...plugin.skills.filter(skill => [skill.id, skill.name, ...skill.aliases,
        ...[plugin.id, ...plugin.aliases].flatMap(name => [skill.name, ...skill.aliases].map(skillName => `${name}:${skillName}`))].includes(id))
        .map(skill => ({ plugin, skill })),
    ]).filter(({ plugin }) => options.reference === undefined || plugin.reference === options.reference);
    if (matches.length > 1) return { code: 'skill-ambiguous', data: { candidates: matches.map(({ plugin, skill }) => ({ id: skill?.id ?? plugin.id, version: plugin.version, root: plugin.base, reference: plugin.reference, ...(skill ? { resource: skill.resource } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)) } };
    if (!matches.length) return { code: options.reference !== undefined
      ? 'stale-plugin-reference' : 'skill-not-found-or-ambiguous' };
    const { plugin, skill } = matches[0]!;
    if (options.reference === undefined && this.conflicted(plugin.id)) return this.resolveInspect(plugin.id);
    if (!skill) return { code: 'plugin', data: await this.describe(plugin) };
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

function availability(skills: readonly { available: boolean }[]): 'available' | 'partial' | 'unavailable' {
  return skills.every(s => s.available) ? 'available' : skills.some(s => s.available) ? 'partial' : 'unavailable';
}

async function unchanged(plugin: Plugin): Promise<boolean> {
  try {
    if (await readFile(await inside(plugin.base, '.codex-plugin/plugin.json'), 'utf8') !== plugin.manifest) return false;
    const current = new Map<string, Resource>();
    const directories = new Set<string>();
    for (const root of plugin.contentRoots) await snapshot(plugin.base, root, current, plugin.scopes, [], directories);
    if (JSON.stringify([...directories].sort()) !== JSON.stringify(plugin.directories)) return false;
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
    if (!/^[a-z][a-z0-9-]*$/.test(name) || Object.keys(skill).some(key => !['requires', 'aliases'].includes(key))) throw new Error('invalid-metadata');
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

async function snapshot(base: string, path: string, files: Map<string, Resource>, scopes: string[], ancestors: string[] = [], directoryNames = new Set<string>()): Promise<void> {
  const directory = await inside(base, path);
  if (!scopes.some(scope => contained(scope, directory))) throw new Error('invalid-path');
  const info = await stat(directory);
  if (info.isFile()) { files.set(path.split(sep).join('/'), { content: await readFile(directory), path: directory }); return; }
  if (!info.isDirectory()) throw new Error('invalid-path');
  directoryNames.add(path);
  if (ancestors.includes(directory)) throw new Error('invalid-path');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const resource = join(path, entry.name).split(sep).join('/');
    const target = await inside(base, resource);
    if (!scopes.some(scope => contained(scope, target))) throw new Error('invalid-path');
    const info = await stat(target);
    if (info.isDirectory()) await snapshot(base, resource, files, scopes, [...ancestors, directory], directoryNames);
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
