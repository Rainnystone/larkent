import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isAgentKind, type AgentKind } from '../../src/agent/registry';
import { defaultLiveRootDir } from '../../src/runtime/live-root';
import { findPlaceholders } from './placeholders';
import { defaultDataRoot, resolveExistingPath } from './paths';

export class TestBridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestBridgeConfigError';
  }
}

export interface TestBridgeConfig {
  instance: string;
  profile: string;
  agentKind: AgentKind;
  tenant: 'feishu' | 'lark';
  appId: string;
  appSecret: string;
  chatId: string;
  testerOpenId: string;
  botOpenId?: string;
  allowedUsers: string[];
  allowedChats: string[];
  testerConfigDir: string;
  testerTokenFile?: string;
  dataRoot: string;
  fenceEnabled: true;
}

export async function loadTestBridgeConfig(
  path: string,
  opts: { home?: string; cwd?: string } = {},
): Promise<TestBridgeConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const absolute = resolveExistingPath(path, cwd);
  const raw = await readJson(absolute);
  const placeholders = findPlaceholders(raw);
  if (placeholders.length > 0) {
    throw new TestBridgeConfigError(
      `config still contains example placeholders at ${placeholders.join(', ')}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TestBridgeConfigError('config must be a JSON object');
  }
  const rec = raw as Record<string, unknown>;
  const instance = requiredString(rec, 'instance');
  const profile = optionalString(rec, 'profile') ?? 'e2e';
  const agentKindRaw = optionalString(rec, 'agentKind') ?? 'cursor';
  if (!isAgentKind(agentKindRaw)) {
    throw new TestBridgeConfigError(`unsupported agentKind: ${agentKindRaw}`);
  }
  const tenant = optionalString(rec, 'tenant') ?? 'feishu';
  if (tenant !== 'feishu' && tenant !== 'lark') {
    throw new TestBridgeConfigError('tenant must be feishu or lark');
  }
  const appId = requiredString(rec, 'appId');
  const appSecret = requiredString(rec, 'appSecret');
  const chatId = requiredString(rec, 'chatId');
  const testerOpenId = requiredString(rec, 'testerOpenId');
  const testerConfigDir = resolveExistingPath(requiredString(rec, 'testerConfigDir'), cwd);
  const dataRootRaw = optionalString(rec, 'dataRoot');
  const dataRoot = dataRootRaw
    ? resolveExistingPath(dataRootRaw, cwd)
    : defaultDataRoot(instance, opts.home);
  const live = resolve(opts.home ? defaultLiveRootDir(opts.home) : defaultLiveRootDir());
  await assertNotLiveRoot(dataRoot, live);
  await assertTesterOutsideDataRoot(testerConfigDir, dataRoot);

  return {
    instance,
    profile,
    agentKind: agentKindRaw,
    tenant,
    appId,
    appSecret,
    chatId,
    testerOpenId,
    ...(optionalString(rec, 'botOpenId') ? { botOpenId: optionalString(rec, 'botOpenId') } : {}),
    allowedUsers: stringArray(rec.allowedUsers) ?? [testerOpenId],
    allowedChats: stringArray(rec.allowedChats) ?? [chatId],
    testerConfigDir,
    ...(optionalString(rec, 'testerTokenFile')
      ? { testerTokenFile: resolveExistingPath(String(rec.testerTokenFile), cwd) }
      : {}),
    dataRoot,
    fenceEnabled: true,
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TestBridgeConfigError(`config not found: ${path}`);
    }
    throw err;
  }
}

function requiredString(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new TestBridgeConfigError(`${key} is required`);
  }
  return value.trim();
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TestBridgeConfigError(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TestBridgeConfigError('allowlists must be string arrays');
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

async function assertNotLiveRoot(dataRoot: string, live: string): Promise<void> {
  const root = await resolvedIfExists(dataRoot);
  const liveRoot = await resolvedIfExists(live);
  if (root === liveRoot || isInside(root, liveRoot)) {
    throw new TestBridgeConfigError('test bridge refused to use the live data root');
  }
}

async function assertTesterOutsideDataRoot(testerDir: string, dataRoot: string): Promise<void> {
  const tester = await resolvedIfExists(testerDir);
  const root = await resolvedIfExists(dataRoot);
  if (tester === root || isInside(tester, root)) {
    throw new TestBridgeConfigError('tester config dir must live outside the test data root');
  }
}

async function resolvedIfExists(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    await stat(absolute);
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function isInside(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
