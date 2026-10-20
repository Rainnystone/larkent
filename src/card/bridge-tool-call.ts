/**
 * Identify an internal `lark-channel-bridge tool` invocation from any runtime's
 * shell-tool input (Bash, Shell, command_execution, …). Shared by the card
 * renderer so CLI adapters do not each special-case the client.
 */

const CLIENT_BASENAME = /^lark-channel-bridge(?:\.mjs)?$/i;
const OPERATION_KEY = /"operation"\s*:\s*"((?:automation|plugins)\.[^"]+)"/;

export function bridgeToolLabel(input: unknown): string | undefined {
  if (!isBridgeToolInvocation(input)) return undefined;
  return labelForOperation(extractOperation(input));
}

function isBridgeToolInvocation(input: unknown): boolean {
  const argv = commandArgv(input);
  if (!argv) return false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !isClientToken(token)) continue;
    if (argv[i + 1] === 'tool') return true;
  }
  return false;
}

function isClientToken(token: string): boolean {
  if (token.includes('LARK_BRIDGE_TOOL_CLIENT')) return true;
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return CLIENT_BASENAME.test(base);
}

function labelForOperation(operation: string | undefined): string {
  if (operation?.startsWith('automation.')) return `自动化：${operation.slice('automation.'.length)}`;
  if (operation?.startsWith('plugins.')) return `插件：${operation.slice('plugins.'.length)}`;
  return 'bridge 工具';
}

function extractOperation(input: unknown): string | undefined {
  for (const blob of collectBlobs(input)) {
    const found = operationInText(blob);
    if (found) return found;
  }
  return undefined;
}

function operationInText(text: string): string | undefined {
  const trimmed = text.trim();
  const direct = operationFromJson(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const nested = operationFromJson(trimmed.slice(start, end + 1));
    if (nested) return nested;
  }
  return OPERATION_KEY.exec(text)?.[1];
}

function operationFromJson(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const operation = (value as { operation?: unknown }).operation;
    return typeof operation === 'string' && operation.length > 0 ? operation : undefined;
  } catch {
    return undefined;
  }
}

function collectBlobs(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (!input || typeof input !== 'object') return [];
  const rec = input as Record<string, unknown>;
  const blobs: string[] = [];
  if (typeof rec.command === 'string') blobs.push(rec.command);
  if (Array.isArray(rec.command)) {
    for (const part of rec.command) {
      if (typeof part === 'string') blobs.push(part);
    }
  }
  if (typeof rec.cmd === 'string') blobs.push(rec.cmd);
  if (typeof rec.stdin === 'string') blobs.push(rec.stdin);
  if (typeof rec.input === 'string') blobs.push(rec.input);
  if (rec.rawInput !== undefined) blobs.push(...collectBlobs(rec.rawInput));
  return blobs;
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
  if (rec.rawInput !== undefined) return commandArgv(rec.rawInput);
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
