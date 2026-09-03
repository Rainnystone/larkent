import { resolveDescriptorBinary } from '../../cli/agent-detection';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { descriptorFor } from '../registry';
import { runJsonlAgent } from '../runner/jsonl-cli-runner';
import {
  mergeAgentOptions,
  runAgentOptions,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { assertCursorSandbox, buildCursorArgs } from './argv';
import { parseCursorAgentOptions } from './options';

export interface CursorAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor CLI';

  private binary: string;
  private readonly explicitBinary: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly profileOptions: unknown;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CursorAdapterOptions = {}) {
    this.explicitBinary = Boolean(opts.binary);
    this.binary = opts.binary ?? descriptorFor('cursor').binaryNames[0] ?? 'cursor-agent';
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
    if (!this.explicitBinary) {
      try {
        this.binary = await resolveDescriptorBinary('cursor');
      } catch {
        // Keep the default name so preflight can emit agent-binary-not-found.
      }
    }
    return checkAgentAvailability({
      agentId: 'cursor',
      agentName: 'Cursor CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    const parsed = parseCursorAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    assertCursorSandbox(parsed.sandbox);
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'cursor binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CursorAdapter.run');
    }
    const parsed = parseCursorAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    assertCursorSandbox(parsed.sandbox);

    return runJsonlAgent({
      runId: opts.runId,
      name: this.id,
      binaryPath: this.binary,
      argv: buildCursorArgs({
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        ...(opts.resumeHandle ? { sessionId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      translator: descriptorFor('cursor').createTranslator(),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
    });
  }
}
