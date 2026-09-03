import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeProcessEnv } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
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
import { buildClaudeArgs } from './argv';
import { CLAUDE_DEFAULT_PERMISSION_MODE, parseClaudeAgentOptions } from './options';

export interface ClaudeAdapterOptions {
  binary?: string;
  agentOptions?: unknown;
  larkChannel?: LarkChannelEnvContext;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly profileOptions: unknown;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
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
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    const prepared = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));
    const parsed = parseClaudeAgentOptions(
      mergeAgentOptions(this.profileOptions, runAgentOptions(opts)),
      false,
    );
    return runJsonlAgent({
      runId: opts.runId,
      name: this.id,
      binaryPath: this.binary,
      argv: buildClaudeArgs({
        permissionMode: parsed.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
        systemPromptFile: prepared.path,
        sessionId: opts.resumeHandle,
        model: opts.model,
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdin: opts.prompt,
      translator: descriptorFor('claude').createTranslator(),
      cleanup: prepared.cleanup,
      stopGraceMs: opts.stopGraceMs ?? 5000,
    });
  }
}

function writeSystemPromptFile(content: string): { path: string; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: async () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        return;
      }
    },
  };
}
