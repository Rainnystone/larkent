import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
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
import { buildCodexArgs } from './argv';
import {
  parseCodexAgentOptions,
  type CodexAgentOptions,
  type CodexSandboxOption,
} from './options';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  agentOptions?: unknown;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly profileOptions: CodexAgentOptions;
  private readonly sandbox: CodexSandboxOption;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.profileOptions = parseCodexAgentOptions(
      mergeAgentOptions(
        {
          ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
          inheritCodexHome: opts.inheritCodexHome,
          ignoreUserConfig: opts.ignoreUserConfig,
          ignoreRules: opts.ignoreRules,
          ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        },
        opts.agentOptions,
      ),
      false,
    );
    this.sandbox = this.profileOptions.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  private get codexHome(): string | undefined {
    return this.profileOptions.codexHome;
  }

  private get inheritCodexHome(): boolean {
    return this.profileOptions.inheritCodexHome !== false;
  }

  private get ignoreUserConfig(): boolean {
    return this.profileOptions.ignoreUserConfig === true;
  }

  private get ignoreRules(): boolean {
    return this.profileOptions.ignoreRules !== false;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    const parsed = parseCodexAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }

    return runJsonlAgent({
      runId: opts.runId,
      name: this.id,
      binaryPath: this.binary,
      argv: buildCodexArgs({
        cwd: opts.cwd,
        sandbox: parsed.sandbox ?? this.sandbox,
        threadId: opts.resumeHandle,
        images: opts.images,
        ignoreUserConfig: parsed.ignoreUserConfig ?? this.ignoreUserConfig,
        ignoreRules: parsed.ignoreRules ?? this.ignoreRules,
        model: opts.model,
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdin: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
      translator: descriptorFor('codex').createTranslator(),
      stopGraceMs: opts.stopGraceMs ?? this.defaultStopGraceMs,
    });
  }
}
