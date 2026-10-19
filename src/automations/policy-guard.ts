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

export function inspectAutomationToolUse(event: {
  name: string;
  input: unknown;
}): PolicyGuardHit | undefined {
  const argv = commandArgv(event.input);
  return (argv ? inspectArgv(argv) : undefined) ?? inspectToolName(event.name);
}

function inspectToolName(name: string): PolicyGuardHit | undefined {
  const normalized = name.toLowerCase().replace(/_/g, '.');
  return inspectLarkArgs([normalized])
    ?? inspectLarkArgs(normalized.split(/[^a-z0-9+-]+/i).filter(Boolean));
}

function inspectArgv(raw: readonly string[]): PolicyGuardHit | undefined {
  const argv = stripWrappers(raw);
  if (argv.length === 0) return undefined;
  const larkIndex = argv.findIndex((token) => LARK_CLI_NAME.test(token));
  if (larkIndex >= 0) return inspectLarkArgs(argv.slice(larkIndex + 1));
  for (const token of argv) {
    const nested = tokenize(token);
    if (nested.length <= 1) continue;
    const hit = inspectArgv(nested);
    if (hit) return hit;
  }
  return undefined;
}

function inspectLarkArgs(args: readonly string[]): PolicyGuardHit | undefined {
  const positional = args.filter((token) => !token.startsWith('-')).map((token) => token.toLowerCase());
  if (mutatesIdentityConfiguration(args, positional)) return { reason: 'auth-config' };
  return undefined;
}

function mutatesIdentityConfiguration(args: readonly string[], positional: readonly string[]): boolean {
  const auth = positional.indexOf('auth');
  if (auth >= 0 && ['login', 'logout'].includes(positional[auth + 1] ?? '')) return true;
  const config = positional.indexOf('config');
  if (config < 0) return false;
  const operation = positional[config + 1];
  if (operation === 'strict-mode' || operation === 'default-as') {
    // With no value these commands only display the current policy.
    return positional[config + 2] !== undefined || args.some(arg => /^--reset(?:=true)?$/i.test(arg));
  }
  return operation !== undefined && ['set', 'bind', 'unbind', 'init', 'remove'].includes(operation);
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
  const token = /(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  for (const match of command.matchAll(token)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}
