/**
 * Identify an internal `lark-channel-bridge tool` invocation from any runtime's
 * shell-tool input (Bash, Shell, command_execution, …). Shared by the card
 * renderer so CLI adapters do not each special-case the client.
 */

const CLIENT_BASENAME = /^lark-channel-bridge(?:\.mjs)?$/i;
const CLIENT_VARIABLE = /^\$(?:LARK_BRIDGE_TOOL_CLIENT|\{LARK_BRIDGE_TOOL_CLIENT\}|env:LARK_BRIDGE_TOOL_CLIENT)$/;
const OPERATION_KEY = /"operation"\s*:\s*"((?:automation|plugins)\.[^"]+)"/;

export function bridgeToolLabel(input: unknown): string | undefined {
  if (!isBridgeToolInvocation(input)) return undefined;
  return labelForOperation(extractOperation(input));
}

/** Conservative visibility fallback, never a reason to hide command/output. */
export function hasBridgeToolReference(input: unknown): boolean {
  return collectBlobs(input).some(blob => blob.includes('LARK_BRIDGE_TOOL_CLIENT') || blob.includes('lark-channel-bridge'));
}

function isBridgeToolInvocation(input: unknown): boolean {
  const argv = commandArgv(input);
  if (!argv) return false;
  const clientIndex = /^(?:.*[/\\])?node(?:\.exe)?$/i.test(argv[0] ?? '') ? 1 : 0;
  return isClientToken(argv[clientIndex] ?? '') && argv[clientIndex + 1] === 'tool'
    && (argv.length === clientIndex + 2 || (argv.length === clientIndex + 3 && argv.at(-1) === '--schema'));
}

function isClientToken(token: string): boolean {
  if (CLIENT_VARIABLE.test(token)) return true;
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
  if (typeof input === 'string') return standaloneCommand(input);
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec.command) && rec.command.every((part) => typeof part === 'string')) {
    return rec.command.some(part => CLIENT_VARIABLE.test(part)) ? undefined : rec.command;
  }
  if (typeof rec.command === 'string') return standaloneCommand(rec.command);
  if (typeof rec.cmd === 'string') return standaloneCommand(rec.cmd);
  if (rec.rawInput !== undefined) return commandArgv(rec.rawInput);
  return undefined;
}

interface ShellWord {
  value: string;
  expanded: boolean;
  quoted: boolean;
}
type ShellToken = ShellWord | '<<' | '|';

/** Recognize only our input forms. Unsupported shell syntax must keep its card body. */
function standaloneCommand(command: string): string[] | undefined {
  const [head = '', ...lines] = command.split(/\r?\n/);
  let tokens = shellTokens(head);
  if (!tokens) return undefined;
  const heredoc = tokens.indexOf('<<');
  if (heredoc >= 0) {
    const delimiter = tokens[heredoc + 1];
    if (tokens.filter(token => token === '<<').length !== 1 || !delimiter || typeof delimiter === 'string'
      || delimiter.expanded || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(delimiter.value)) return undefined;
    const end = lines.indexOf(delimiter.value);
    if (end < 0 || lines.slice(end + 1).join('\n').trim()) return undefined;
    if (!delimiter.quoted && /[$`\\]/.test(lines.slice(0, end).join('\n'))) return undefined;
    tokens.splice(heredoc, 2);
  } else if (lines.join('\n').trim()) return undefined;
  const pipe = tokens.indexOf('|');
  if (pipe >= 0) {
    const source = tokens.slice(0, pipe);
    if (source.some(token => typeof token === 'string' || token.expanded)) return undefined;
    const args = (source as ShellWord[]).map(word => word.value);
    const literalStdin = (args[0] === 'echo' && args.length === 2 && !args[1]!.startsWith('-'))
      || (args[0] === 'printf' && args.length === 3 && ['%s', '%s\\n'].includes(args[1]!))
      || (heredoc >= 0 && heredoc <= pipe && args.length === 1 && args[0] === 'cat');
    if (!literalStdin) return undefined;
    tokens = tokens.slice(pipe + 1);
  }
  if (tokens.some(token => typeof token === 'string')) return undefined;
  const words = tokens as ShellWord[];
  if (words.some(word => word.expanded ? !CLIENT_VARIABLE.test(word.value) : CLIENT_VARIABLE.test(word.value))) return undefined;
  return words.map(word => word.value);
}

/** Quote-aware lexer for words, stdin heredocs and pipes; never executes or expands input. */
function shellTokens(command: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let word: ShellWord | undefined;
  let quote: "'" | '"' | undefined;
  const flush = () => { if (word) tokens.push(word); word = undefined; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (!quote && /\s/.test(char)) { flush(); continue; }
    if (!quote && (char === '|' || command.slice(i, i + 2) === '<<')) {
      flush();
      tokens.push(char === '|' ? '|' : '<<');
      if (char === '<') i++;
      continue;
    }
    if (!quote && /[;&<>(){}#*?\[\]]/.test(char)) return undefined;
    word ??= { value: '', expanded: false, quoted: false };
    if (char === quote) { quote = undefined; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; word.quoted = true; continue; }
    if (quote !== "'" && char === '`') return undefined;
    if (quote !== "'" && char === '\\') {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      if (!quote || /[$`"\\]/.test(next)) { word.value += next; i++; continue; }
    }
    if (quote !== "'" && char === '$') {
      const variable = /^\$(?:\{[A-Za-z_][A-Za-z0-9_:]*\}|[A-Za-z_][A-Za-z0-9_:]*)/.exec(command.slice(i));
      if (!variable) return undefined;
      word.value += variable[0];
      word.expanded = true;
      i += variable[0].length - 1;
      continue;
    }
    word.value += char;
  }
  if (quote) return undefined;
  flush();
  return tokens;
}
