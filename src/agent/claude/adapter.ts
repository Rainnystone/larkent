import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeProcessEnv } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { runJsonlCli, wrapParsedTranslator } from '../runner/jsonl-cli-runner';
import { translateEvent } from './stream-json';
import {
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { buildClaudeArgs } from './argv';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
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

    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));
    return runJsonlCli({
      runId: opts.runId,
      binaryPath: this.binary,
      argv: buildClaudeArgs({
        systemPromptFile: systemPromptFile.path,
        permissionMode: opts.permissionMode,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      }),
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdin: opts.prompt,
      translator: wrapParsedTranslator(
        { translate: (parsed) => translateEvent(parsed) },
        'claude',
      ),
      cleanup: () => systemPromptFile.cleanup(),
      stopGraceMs: opts.stopGraceMs ?? 5000,
      spawnName: 'claude',
      emptyStdoutDestroyMs: 50,
      failNonzeroAfterTerminal: true,
      logFields: {
        hasSession: Boolean(opts.sessionId),
        promptChars: opts.prompt.length,
        model: opts.model,
      },
    });
  }
}

function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}
