import { agentSpawnEnv } from '../spawn-env';
import { logEffectiveAdapterTiming } from '../../runtime/effective-adapter-timing';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { runJsonlCli, wrapParsedTranslator } from '../runner/jsonl-cli-runner';
import {
  asAgentOptionsObject,
  mergeAgentOptions,
  runAgentOptions,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { assertAntigravitySandbox, buildAntigravityArgs } from './argv';
import { AntigravityJsonlTranslator } from './jsonl';
import { parseAntigravityAgentOptions } from './options';

export interface AntigravityAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  idleTimeoutMs?: number;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly displayName = 'Antigravity CLI';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly profileOptions: unknown;
  private readonly idleTimeoutMs: number | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: AntigravityAdapterOptions = {}) {
    this.binary = opts.binary ?? 'agy';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.profileOptions = opts.agentOptions === undefined
      ? undefined
      : asAgentOptionsObject(opts.agentOptions, 'antigravity');
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'antigravity',
      agentName: 'Antigravity CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    const parsed = parseAntigravityAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    assertAntigravitySandbox(parsed.sandbox);
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'agy binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for AntigravityAdapter.run');
    }
    const parsed = parseAntigravityAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    assertAntigravitySandbox(parsed.sandbox);
    logEffectiveAdapterTiming('run', {
      ...(this.larkChannel?.profile ? { profile: this.larkChannel.profile } : {}),
      agentKind: 'antigravity',
      ...(this.larkChannel?.configPath ? { configPath: this.larkChannel.configPath } : {}),
      printTimeout: parsed.printTimeout,
      printTimeoutSupported: true,
      idleTimeoutMs: this.idleTimeoutMs,
    });

    return runJsonlCli({
      runId: opts.runId,
      binaryPath: this.binary,
      argv: buildAntigravityArgs({
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity, opts.promptVariant),
        ...(opts.resumeHandle ? { conversationId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
        ...(parsed.printTimeout ? { printTimeout: parsed.printTimeout } : {}),
      }),
      cwd: opts.cwd,
      env: agentSpawnEnv(process.env, buildLarkChannelEnv(this.larkChannel, opts.toolEnv)),
      translator: wrapParsedTranslator(new AntigravityJsonlTranslator(), 'agy'),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
      spawnName: 'agy',
      missingTerminalOnSuccess: 'agy exited before a terminal stream-json result event',
      logFields: {
        hasSession: Boolean(opts.resumeHandle),
        promptChars: opts.prompt.length,
        model: opts.model,
      },
    });
  }
}
