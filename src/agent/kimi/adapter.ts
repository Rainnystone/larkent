import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { descriptorFor } from '../registry';
import { runJsonlAgent } from '../runner/jsonl-cli-runner';
import type { AgentAdapter, AgentBotIdentity, AgentRun, AgentRunOptions } from '../types';
import { buildKimiArgs } from './argv';

export interface KimiAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class KimiAdapter implements AgentAdapter {
  readonly id = 'kimi';
  readonly displayName = 'Kimi Code';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: KimiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'kimi';
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
      agentId: 'kimi',
      agentName: 'Kimi Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'kimi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for KimiAdapter.run');
    }

    return runJsonlAgent({
      runId: opts.runId,
      name: this.id,
      binaryPath: this.binary,
      argv: buildKimiArgs({
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        ...(opts.resumeHandle ? { sessionId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      translator: descriptorFor('kimi').createTranslator(),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
    });
  }
}
