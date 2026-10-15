import { loadTestBridgeConfig } from './config';
import {
  armDriverFault,
  down,
  freezeBridge,
  killCli,
  setProxyMode,
  up,
} from './driver';
import { DEFAULT_LOCAL_CONFIG, defaultDataRoot } from './paths';
import { PROXY_MODES, type FaultProxyMode } from './proxy';
import { runJournalKillGroup } from './scenarios/journal-kill-group';
import { runRedeliveryShortGap } from './scenarios/redelivery-short-gap';
import { readTesterMessages, sendTesterMessage } from './tester';

type CliCommand = 'up' | 'down' | 'fault' | 'send' | 'read' | 'scenario' | 'help';

async function main(argv: string[]): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('e2e test-bridge commands are POSIX-only');
  }
  const command = parseCommand(argv[0]);
  const rest = argv.slice(1);
  switch (command) {
    case 'up':
      await cmdUp(rest);
      return;
    case 'down':
      await cmdDown(rest);
      return;
    case 'fault':
      await cmdFault(rest);
      return;
    case 'send':
      await cmdSend(rest);
      return;
    case 'read':
      await cmdRead(rest);
      return;
    case 'scenario':
      await cmdScenario(rest);
      return;
    case 'help':
      printHelp();
      return;
    default: {
      const _never: never = command;
      throw new Error(`unknown e2e command: ${String(_never)}`);
    }
  }
}

function parseCommand(value: string | undefined): CliCommand {
  switch (value) {
    case 'up':
    case 'down':
    case 'fault':
    case 'send':
    case 'read':
    case 'scenario':
      return value;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return 'help';
    default:
      throw new Error(`unknown e2e command: ${value}`);
  }
}

async function cmdUp(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const config = await loadTestBridgeConfig(stringFlag(flags, 'config') ?? DEFAULT_LOCAL_CONFIG);
  const running = await up({
    config,
    realCli: Boolean(flags['real-cli']),
    ...(stringFlag(flags, 'real-cli-path') ? { realCliPath: stringFlag(flags, 'real-cli-path') } : {}),
  });
  console.log(`test-bridge up pid=${running.pid} root=${running.rootDir} proxy=${running.proxyUrl}`);
}

async function cmdDown(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dataRoot = await resolveDataRoot(flags);
  await down(dataRoot);
  console.log('test-bridge down');
}

async function cmdFault(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const flags = parseFlags(rest);
  const dataRoot = await resolveDataRoot(flags);
  switch (sub) {
    case 'arm': {
      const mode = rest.find((item) => !item.startsWith('--'));
      if (!mode) throw new Error('usage: e2e:fault arm <mode> [--run-id N] [--sticky]');
      await armDriverFault(dataRoot, mode, {
        ...(stringFlag(flags, 'run-id') ? { runId: stringFlag(flags, 'run-id') } : {}),
        sticky: Boolean(flags.sticky) || mode.endsWith(':sticky'),
      });
      console.log(`armed ${mode}`);
      return;
    }
    case 'proxy': {
      const mode = rest.find((item) => !item.startsWith('--'));
      if (!mode || !isProxyMode(mode)) {
        throw new Error(`usage: e2e:fault proxy <${PROXY_MODES.join('|')}>`);
      }
      await setProxyMode(dataRoot, mode, {
        ...(stringFlag(flags, 'delay-ms') ? { delayMs: Number(flags['delay-ms']) } : {}),
        ...(stringFlag(flags, 'host') ? { hosts: [String(flags.host)] } : {}),
      });
      console.log(`proxy ${mode}`);
      return;
    }
    case 'kill-cli':
      await killCli(
        dataRoot,
        flags['process-group'] ? 'process-group' : 'child-only',
      );
      console.log('kill-cli sent');
      return;
    case 'ws-freeze':
      await freezeBridge(dataRoot, true);
      console.log('ws-freeze SIGSTOP (wake-up only; e2e:fault ws-unfreeze to continue)');
      return;
    case 'ws-unfreeze':
      await freezeBridge(dataRoot, false);
      console.log('ws-unfreeze SIGCONT');
      return;
    default:
      throw new Error('usage: e2e:fault arm|proxy|kill-cli|ws-freeze|ws-unfreeze');
  }
}

async function cmdSend(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const config = await loadTestBridgeConfig(stringFlag(flags, 'config') ?? DEFAULT_LOCAL_CONFIG);
  const text = stringFlag(flags, 'text') ?? 'ping';
  const sent = await sendTesterMessage(config, text);
  console.log(`sent${sent.messageId ? ` id=redacted` : ''}`);
}

async function cmdRead(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const config = await loadTestBridgeConfig(stringFlag(flags, 'config') ?? DEFAULT_LOCAL_CONFIG);
  const messages = await readTesterMessages(config, {
    pageSize: stringFlag(flags, 'limit') ? Number(flags.limit) : 10,
  });
  console.log(JSON.stringify(messages.map((item) => ({ text: item.text, createTime: item.createTime }))));
}

async function cmdScenario(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (name) {
    case 'redelivery-short-gap': {
      const result = await runRedeliveryShortGap({
        configPath: stringFlag(flags, 'config') ?? DEFAULT_LOCAL_CONFIG,
        gapSec: stringFlag(flags, 'gap-sec') ? Number(flags['gap-sec']) : undefined,
        realCli: Boolean(flags['real-cli']),
        startBridge: Boolean(flags.up),
      });
      console.log(JSON.stringify(result));
      return;
    }
    case 'journal-kill-group': {
      const result = await runJournalKillGroup({
        configPath: stringFlag(flags, 'config') ?? DEFAULT_LOCAL_CONFIG,
        realCli: Boolean(flags['real-cli']),
        startBridge: Boolean(flags.up),
      });
      console.log(JSON.stringify(result));
      return;
    }
    default:
      throw new Error('usage: e2e:scenario redelivery-short-gap|journal-kill-group');
  }
}

async function resolveDataRoot(flags: Record<string, string | boolean>): Promise<string> {
  const explicit = stringFlag(flags, 'data-root');
  if (explicit) return explicit;
  const configPath = stringFlag(flags, 'config');
  if (configPath) {
    const config = await loadTestBridgeConfig(configPath);
    return config.dataRoot;
  }
  try {
    const config = await loadTestBridgeConfig(DEFAULT_LOCAL_CONFIG);
    return config.dataRoot;
  } catch {
    const instance = stringFlag(flags, 'instance') ?? 'e2e-1';
    return defaultDataRoot(instance);
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item?.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function isProxyMode(value: string): value is FaultProxyMode {
  return (PROXY_MODES as readonly string[]).includes(value);
}

function printHelp(): void {
  console.log(`test-bridge (POSIX)
  pnpm e2e:up -- [--config e2e/.local/test-bridge.json] [--real-cli]
  pnpm e2e:down
  pnpm e2e:fault -- arm cursor-stall --run-id 2
  pnpm e2e:fault -- proxy disconnect [--host open.feishu.cn]
  pnpm e2e:fault -- kill-cli --child-only | --process-group
  pnpm e2e:fault -- ws-freeze
  pnpm e2e:send -- --text ping
  pnpm e2e:read
  pnpm e2e:scenario -- redelivery-short-gap
  pnpm e2e:scenario -- journal-kill-group [--up]
`);
}

const args = process.argv.slice(2);
main(args).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
