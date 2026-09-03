import { resolveCursorBinary } from '../../cli/agent-detection';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { descriptorFor } from '../registry';
import { runJsonlCli, wrapParsedTranslator } from '../runner/jsonl-cli-runner';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { assertCursorSandbox, buildCursorArgs } from './argv';
import { CursorJsonlTranslator } from './jsonl';

export interface CursorAdapterOptions {
  binary?: string;
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
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CursorAdapterOptions = {}) {
    this.explicitBinary = Boolean(opts.binary);
    this.binary = opts.binary ?? descriptorFor('cursor').binaryNames[0] ?? 'cursor-agent';
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
    if (!this.explicitBinary) {
      try {
        this.binary = await resolveCursorBinary();
      } catch {
        this.binary = descriptorFor('cursor').binaryNames[0] ?? 'cursor-agent';
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
    assertCursorSandbox(opts.sandbox);
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
    assertCursorSandbox(opts.sandbox);

    return runJsonlCli({
      runId: opts.runId,
      binaryPath: this.binary,
      argv: buildCursorArgs({
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        ...(opts.resumeHandle ? { sessionId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      translator: wrapParsedTranslator(new CursorJsonlTranslator(), 'cursor'),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
      spawnName: 'cursor',
      missingTerminalOnSuccess: 'cursor stream ended before a terminal event',
      logFields: {
        hasSession: Boolean(opts.resumeHandle),
        promptChars: opts.prompt.length,
        model: opts.model,
      },
    });
  }
}
