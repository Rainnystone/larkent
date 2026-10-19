/**
 * Bridge-layer whitelist for unattended agent-task fires.
 *
 * This is defence in depth, not a security boundary: the agent still has a
 * full shell. Personnel/org lark-cli calls and user-identity requests stop
 * the fire with `policy-guard`.
 */

export type PolicyGuardReason =
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
  const joined = positional.join(' ');

  if (
    (joined.includes('chat.members') && (joined.includes('create') || joined.includes('delete')))
    || /\+chat-members-(add|remove|create|delete)\b/.test(joined)
  ) {
    return { reason: 'members' };
  }
  if (
    joined.includes('+chat-create')
    || /(^| )chats create( |$)/.test(joined)
    || joined.includes('chats.create')
  ) {
    return { reason: 'chat-create' };
  }
  if (
    /(^| )chats delete( |$)/.test(joined)
    || joined.includes('chats.delete')
    || joined.includes('me_leave')
    || joined.includes('+chat-leave')
  ) {
    return { reason: 'leave' };
  }
  if (
    joined.includes('+chat-update')
    || /(^| )chats update( |$)/.test(joined)
    || joined.includes('chats.update')
    || joined.includes('chat.managers')
    || (joined.includes('chat.moderation') && joined.includes('update'))
    || (joined.includes('chat.user_setting') && joined.includes('batch_update'))
    || (joined.includes('chat.join_requests') && joined.includes('handle'))
  ) {
    return { reason: 'chat-settings' };
  }
  if (positional[0] === 'contact' || positional[0] === 'contacts' || positional[0] === 'directory') {
    return { reason: 'contacts' };
  }
  if (
    positional[0] === 'corehr'
    || positional[0] === 'ehr'
    || positional[0] === 'hr'
    || positional[0] === 'people'
  ) {
    return { reason: 'hr' };
  }
  if (requestsUserIdentity(args, positional)) return { reason: 'user-identity' };
  return undefined;
}

function requestsUserIdentity(args: readonly string[], positional: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    const next = args[i + 1];
    if (token === '--as' && next?.toLowerCase() === 'user') return true;
    if (token.toLowerCase() === '--as=user') return true;
    if (token === '--identity' && next === 'user-default') return true;
    if (token.startsWith('--identity=') && token.slice('--identity='.length) === 'user-default') {
      return true;
    }
  }
  if (positional.includes('auth') && positional.includes('login')) return true;
  const strict = args.findIndex((token) => token === 'strict-mode');
  if (strict >= 0 && args[strict + 1] === 'off') return true;
  const defaultAs = args.findIndex((token) => token === 'default-as');
  if (defaultAs >= 0 && args[defaultAs + 1] === 'user') return true;
  return false;
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
