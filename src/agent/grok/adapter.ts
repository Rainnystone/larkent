import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnFailed } from '../../runtime/errors';
import { agentSpawnEnv } from '../spawn-env';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { runJsonlCli, wrapParsedTranslator } from '../runner/jsonl-cli-runner';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildGrokArgs } from './argv';
import { GrokJsonlTranslator } from './jsonl';
import { toGrokPermissionMode, toGrokSandbox } from './options';

export interface GrokAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok Build';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: GrokAdapterOptions = {}) {
    this.binary = opts.binary ?? 'grok';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'grok',
      agentName: 'Grok Build',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'grok binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for GrokAdapter.run');
    }

    const permissionMode = toGrokPermissionMode(opts.permissionMode);
    const sandbox = toGrokSandbox(opts.sandbox);
    const promptFile = writePromptFile(opts.prompt);
    return runJsonlCli({
      runId: opts.runId,
      binaryPath: this.binary,
      argv: buildGrokArgs({
        promptFile: promptFile.path,
        rules: buildBridgeSystemPrompt(this.botIdentity, opts.promptVariant),
        ...(opts.resumeHandle ? { sessionId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(sandbox ? { sandbox } : {}),
      }),
      cwd: opts.cwd,
      env: agentSpawnEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel, opts.toolEnv),
        // Grok's own shell sets FORCE_COLOR. Keeping NO_COLOR makes Node warn
        // on every tool card. Color is removed from tool output instead.
        NO_COLOR: undefined,
        GROK_DISABLE_AUTOUPDATER: '1',
      }),
      translator: wrapParsedTranslator(new GrokJsonlTranslator(), 'grok'),
      cleanup: () => promptFile.cleanup(),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
      spawnName: 'grok',
      missingTerminalOnSuccess: 'grok exited before a terminal streaming-json end event',
      logFields: {
        hasSession: Boolean(opts.resumeHandle),
        promptChars: opts.prompt.length,
        model: opts.model,
      },
    });
  }
}

function writePromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-grok-'));
  chmodSync(dir, 0o700);
  const path = join(dir, 'prompt.txt');
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
