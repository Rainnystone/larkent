import {
  asAgentOptionsObject,
  type AgentOptionsSchema,
  type EffectiveAccess,
} from '../types';

const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type CodexSandboxOption = (typeof CODEX_SANDBOXES)[number];

export type CodexAgentOptions = {
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: CodexSandboxOption;
};

function isCodexSandboxOption(value: unknown): value is CodexSandboxOption {
  return typeof value === 'string' && (CODEX_SANDBOXES as readonly string[]).includes(value);
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`invalid codex agent option ${field}`);
  }
  return value;
}

export function parseCodexAgentOptions(value: unknown, strict = false): CodexAgentOptions {
  const raw = asAgentOptionsObject(value, 'codex');
  const allowed = new Set([
    'codexHome',
    'inheritCodexHome',
    'ignoreUserConfig',
    'ignoreRules',
    'sandbox',
  ]);
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        throw new Error(`unknown codex agent option: ${key}`);
      }
    }
  }
  const options: CodexAgentOptions = {};
  if (raw.codexHome !== undefined) {
    if (typeof raw.codexHome !== 'string') {
      throw new Error('invalid codex agent option codexHome');
    }
    options.codexHome = raw.codexHome;
  }
  const inheritCodexHome = readOptionalBoolean(raw.inheritCodexHome, 'inheritCodexHome');
  if (inheritCodexHome !== undefined) options.inheritCodexHome = inheritCodexHome;
  const ignoreUserConfig = readOptionalBoolean(raw.ignoreUserConfig, 'ignoreUserConfig');
  if (ignoreUserConfig !== undefined) options.ignoreUserConfig = ignoreUserConfig;
  const ignoreRules = readOptionalBoolean(raw.ignoreRules, 'ignoreRules');
  if (ignoreRules !== undefined) options.ignoreRules = ignoreRules;
  if (raw.sandbox !== undefined) {
    if (!isCodexSandboxOption(raw.sandbox)) {
      throw new Error(`invalid codex agent option sandbox: ${String(raw.sandbox)}`);
    }
    options.sandbox = raw.sandbox;
  }
  return options;
}

export const codexAgentOptionsSchema: AgentOptionsSchema = {
  parse: (value) => parseCodexAgentOptions(value, true),
};

export function codexPolicyInputs(options: unknown): Record<string, unknown> {
  const parsed = parseCodexAgentOptions(options, false);
  return {
    codexHome: parsed.codexHome ?? null,
    inheritCodexHome: parsed.inheritCodexHome === true,
  };
}

export function mapCodexEffectiveAccess(access: EffectiveAccess): unknown {
  switch (access) {
    case 'read-only':
      return { sandbox: 'read-only' };
    case 'workspace':
      return { sandbox: 'workspace-write' };
    case 'full':
      return { sandbox: 'danger-full-access' };
    default: {
      const _never: never = access;
      return _never;
    }
  }
}

export function codexAdapterAgentOptions(profile: {
  agent: { options?: unknown };
  codex?: {
    codexHome?: string;
    inheritCodexHome?: boolean;
    ignoreUserConfig?: boolean;
    ignoreRules?: boolean;
  };
}): CodexAgentOptions {
  const legacy = profile.codex
    ? {
        ...(typeof profile.codex.codexHome === 'string' ? { codexHome: profile.codex.codexHome } : {}),
        inheritCodexHome: profile.codex.inheritCodexHome,
        ignoreUserConfig: profile.codex.ignoreUserConfig,
        ignoreRules: profile.codex.ignoreRules,
      }
    : {};
  const fromAgent =
    profile.agent.options &&
    typeof profile.agent.options === 'object' &&
    !Array.isArray(profile.agent.options)
      ? (profile.agent.options as Record<string, unknown>)
      : {};
  return parseCodexAgentOptions({ ...legacy, ...fromAgent }, true);
}

export function shouldUpgradeIsolatedCodexHome(
  inheritWhenIsolated: boolean,
  codex: { codexHome?: string; inheritCodexHome?: boolean } | undefined,
): boolean {
  return (
    inheritWhenIsolated &&
    Boolean(codex) &&
    !codex?.codexHome &&
    codex?.inheritCodexHome === false
  );
}

export function shouldUpgradeIgnoredUserConfig(
  inheritWhenIsolated: boolean,
  codex: { codexHome?: string; ignoreUserConfig?: boolean } | undefined,
): boolean {
  return (
    inheritWhenIsolated &&
    Boolean(codex) &&
    !codex?.codexHome &&
    codex?.ignoreUserConfig === true
  );
}

export function applyCodexLegacyUpgrades<T extends object>(
  codex: T,
  flags: { isolatedHome: boolean; ignoredUser: boolean },
): T {
  return {
    ...codex,
    ...(flags.isolatedHome ? { inheritCodexHome: true } : {}),
    ...(flags.ignoredUser ? { ignoreUserConfig: false } : {}),
  };
}

export function agentOptionsForProfile(profile: {
  agentKind: string;
  agent: { options?: unknown };
  codex?: {
    codexHome?: string;
    inheritCodexHome?: boolean;
    ignoreUserConfig?: boolean;
    ignoreRules?: boolean;
  };
}): unknown {
  if (profile.agentKind === 'codex') return codexAdapterAgentOptions(profile);
  return profile.agent.options ?? {};
}

export function codexThreadHistoryEnv(profile: {
  agent: { options?: unknown };
  codex?: {
    codexHome?: string;
    inheritCodexHome?: boolean;
    ignoreUserConfig?: boolean;
    ignoreRules?: boolean;
  };
}): { codexHome?: string; inheritCodexHome?: boolean } {
  const parsed = codexAdapterAgentOptions(profile);
  return {
    ...(parsed.codexHome ? { codexHome: parsed.codexHome } : {}),
    ...(parsed.inheritCodexHome !== undefined ? { inheritCodexHome: parsed.inheritCodexHome } : {}),
  };
}
