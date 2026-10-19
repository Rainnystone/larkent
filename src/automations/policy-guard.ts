/**
 * Best-effort tool-event guard for unattended authentication/configuration changes.
 *
 * This is defence in depth, not a security boundary: the agent still has a
 * full shell; observing tool events cannot isolate it or guarantee a command
 * has not already executed. Using an existing bot/user identity is allowed.
 */

export type PolicyGuardReason =
  | 'auth-config'
  // Historical reasons remain readable in persisted logs. They are not active policies.
  | 'members'
  | 'chat-create'
  | 'leave'
  | 'chat-settings'
  | 'contacts'
  | 'hr'
  | 'user-identity';

export interface PolicyGuardHit {
  reason: PolicyGuardReason;
}

export function policyGuardReasonLabel(reason: PolicyGuardReason): string {
  switch (reason) {
    case 'auth-config':
      return '认证/身份配置变更';
    case 'members':
      return '成员增删';
    case 'chat-create':
      return '建群';
    case 'leave':
      return '退群';
    case 'chat-settings':
      return '群设置';
    case 'contacts':
      return '通讯录';
    case 'hr':
      return '人事';
    case 'user-identity':
      return '用户身份';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

const LARK_CLI_NAME = /^(?:.*[/\\])?lark-cli(?:\.(?:cmd|exe))?$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'npx', 'command', 'sudo', 'nice', 'time']);
const IDENTITY_FLAG_VALUES = new Set(['--profile', '--as', '--identity']);

export function inspectAutomationToolUse(event: {
  name: string;
  input: unknown;
}): PolicyGuardHit | undefined {
  const argv = commandArgv(event.input);
  return (argv ? inspectArgv(argv) : undefined) ?? inspectToolName(event.name);
}

function inspectToolName(name: string): PolicyGuardHit | undefined {
  const normalized = name.toLowerCase().replace(/_/g, '.');
  const words = normalized.split(/[^a-z0-9+-]+/i).filter(Boolean);
  if (words[0] === 'lark') words.shift();
  if (words[0] === 'cli') words.shift();
  return inspectLarkArgs(words);
}

function inspectArgv(raw: readonly string[]): PolicyGuardHit | undefined {
  const commands: string[][] = [[]];
  for (const token of raw) {
    if (/^(?:&&|\|\||[;|&])$/.test(token)) commands.push([]);
    else commands[commands.length - 1]!.push(token);
  }
  for (const command of commands) {
    const argv = stripWrappers(command);
    const larkIndex = argv.findIndex(token => LARK_CLI_NAME.test(token));
    if (larkIndex >= 0) {
      const hit = inspectLarkArgs(argv.slice(larkIndex + 1));
      if (hit) return hit;
      // A known CLI's quoted arguments are data, not nested shell programs.
      continue;
    }
    for (const token of argv) {
      const nested = tokenize(token);
      if (nested.length <= 1) continue;
      const hit = inspectArgv(nested);
      if (hit) return hit;
    }
  }
  return undefined;
}

function inspectLarkArgs(args: readonly string[]): PolicyGuardHit | undefined {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (IDENTITY_FLAG_VALUES.has(token)) { index++; continue; }
    if (!token.startsWith('-')) positional.push(token.toLowerCase());
  }
  if (mutatesIdentityConfiguration(args, positional)) return { reason: 'auth-config' };
  return undefined;
}

function mutatesIdentityConfiguration(args: readonly string[], positional: readonly string[]): boolean {
  if (positional[0] === 'auth') return ['login', 'logout'].includes(positional[1] ?? '');
  if (positional[0] !== 'config') return false;
  const operation = positional[1];
  if (operation === 'strict-mode' || operation === 'default-as' || operation === 'risk-control') {
    // With no value these commands only display the current policy.
    return positional[2] !== undefined || args.some(arg => /^--reset(?:=true)?$/i.test(arg));
  }
  if (operation === 'tenant-access-token') return ['set', 'remove'].includes(positional[2] ?? '');
  return operation !== undefined && ['set', 'bind', 'unbind', 'init', 'remove', 'keychain-downgrade'].includes(operation);
}

function stripWrappers(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of argv) {
    if (ENV_ASSIGNMENT.test(token)) continue;
    if (WRAPPERS.has(token.toLowerCase())) continue;
    out.push(token);
  }
  return out;
}

function commandArgv(input: unknown): string[] | undefined {
  if (typeof input === 'string') return tokenize(input);
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec.command) && rec.command.every((part) => typeof part === 'string')) {
    return rec.command;
  }
  if (typeof rec.command === 'string') return tokenize(rec.command);
  if (typeof rec.cmd === 'string') return tokenize(rec.cmd);
  if (rec.rawInput && typeof rec.rawInput === 'object') return commandArgv(rec.rawInput);
  return undefined;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const token = /(?:'([^']*)'|"([^"]*)"|(&&|\|\||[;|&]|[^\s;&|]+))/g;
  for (const match of command.matchAll(token)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}
