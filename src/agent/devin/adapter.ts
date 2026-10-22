import { agentSpawnEnv } from '../spawn-env';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { runDevinAcp } from './acp';
import { resolveDevinRunConfig } from './acp-config';
import {
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentRun,
  type AgentRunOptions,
} from '../types';


export interface DevinAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class DevinAdapter implements AgentAdapter {
  readonly id = 'devin';
  readonly displayName = 'Devin CLI';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly profileOptions: unknown;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DevinAdapterOptions = {}) {
    this.binary = opts.binary ?? 'devin';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.profileOptions = opts.agentOptions;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'devin',
      agentName: 'Devin CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'devin binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for DevinAdapter.run');
    }
    const config = resolveDevinRunConfig(this.profileOptions, opts);
    return runDevinAcp({
      binary: this.binary,
      options: opts,
      prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity, opts.promptVariant),
      config,
      env: agentSpawnEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel, opts.toolEnv),
        DEVIN_SANDBOX: config.sandbox ? 'true' : undefined,
      }),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
    });
  }
}
