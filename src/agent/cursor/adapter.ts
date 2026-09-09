import { resolveCursorPathBinary } from '../../cli/agent-detection';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { runJsonlCli, wrapParsedTranslator } from '../runner/jsonl-cli-runner';
import {
  mergeAgentOptions,
  runAgentOptions,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { assertCursorSandbox, buildCursorArgs } from './argv';
import { CursorJsonlTranslator } from './jsonl';
import { cursorMetadata } from './metadata';
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
    this.binary = opts.binary ?? cursorMetadata.binaryNames[0] ?? 'cursor-agent';
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
        this.binary = await resolveCursorPathBinary();
      } catch {
        this.binary = cursorMetadata.binaryNames[0] ?? 'cursor-agent';
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

    return runJsonlCli({
      runId: opts.runId,
      binaryPath: this.binary,
      argv: buildCursorArgs({
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        ...(opts.resumeHandle ? { sessionId: opts.resumeHandle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
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
