import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { CursorAdapter } from '../../../src/agent/cursor/adapter';
import { descriptorFor } from '../../../src/agent/registry';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { log } from '../../../src/core/logger';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { writeScriptedJsonlExecutable } from '../../helpers/fake-executable';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));
import { startChannel } from '../../../src/bot/channel';

// Reported Grok Build 1.0.41 stdout event, replayed by an executable with no
// model/API access. Cursor uses its supported result envelope with known text.
const GROK_ERROR = `Couldn't set model 'grok-build': Invalid params: "unknown model id". Run 'grok models' to see available models.`;
const CURSOR_ERROR = 'stored authentication is invalid';
const CASES: readonly { name: string; kind: 'grok' | 'cursor'; stderr: string; message: string; copy: string; outcome: string; snapshotReady?: boolean }[] = [
  { name: 'Grok reported stdout model error, empty stderr', kind: 'grok', stderr: '', message: GROK_ERROR,
    copy: '未知模型（unknown model id）。请改用 grok models 列出的模型。', outcome: 'failed:unclassified' },
  { name: 'Grok model error, whitespace stderr', kind: 'grok', stderr: ' \t\r\n', message: GROK_ERROR,
    copy: '未知模型（unknown model id）。请改用 grok models 列出的模型。', outcome: 'failed:unclassified' },
  { name: 'Grok model error alongside nonmatching stderr', kind: 'grok', stderr: 'Synthetic diagnostic', message: GROK_ERROR,
    copy: '未知模型（unknown model id）。请改用 grok models 列出的模型。', outcome: 'failed:unclassified' },
  { name: 'Cursor terminal authentication error, empty stderr', kind: 'cursor', stderr: '', message: CURSOR_ERROR,
    copy: 'CLI 登录已失效，需要重新登录后再试', outcome: 'failed:auth-required' },
  { name: 'Cursor terminal authentication error, whitespace stderr', kind: 'cursor', stderr: ' \t\r\n', message: CURSOR_ERROR,
    copy: 'CLI 登录已失效，需要重新登录后再试', outcome: 'failed:auth-required' },
  { name: 'Cursor terminal authentication error alongside nonmatching stderr', kind: 'cursor', stderr: 'Synthetic diagnostic', message: CURSOR_ERROR,
    copy: 'CLI 登录已失效，需要重新登录后再试', outcome: 'failed:auth-required' },
  { name: 'nonempty stderr retains its authentication classification', kind: 'cursor', stderr: CURSOR_ERROR, message: 'Synthetic terminal failure', snapshotReady: true,
    copy: 'CLI 登录已失效，需要重新登录后再试', outcome: 'failed:auth-required' },
  { name: 'existing stderr authentication wins over a conflicting terminal signature', kind: 'cursor', stderr: CURSOR_ERROR, message: 'RetriableError: Connection stalled repeatedly', snapshotReady: true,
    copy: 'CLI 登录已失效，需要重新登录后再试', outcome: 'failed:auth-required' },
];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); sdk.channel = undefined;
});

async function replay(kind: 'grok' | 'cursor', stderr: string, terminalMessage: string, snapshotReady = false) {
  const tmp = await createTmpProfile('terminal-error-'); cleanup.push(tmp.cleanup);
  // Independent OS stdout/stderr pipes have no ordering guarantee. This case
  // explicitly supplies the existing nonempty snapshot before the terminal.
  if (snapshotReady) return { tmp, agent: new FakeAgentAdapter({ id: kind, stderr, events: [{ type: 'error', message: terminalMessage, terminationReason: 'failed' }] }) };
  const binary = await writeScriptedJsonlExecutable(tmp.root, 'protocol-replay', {
    lines: [kind === 'grok' ? { type: 'error', message: terminalMessage }
      : { type: 'result', subtype: 'error', is_error: true, result: terminalMessage }],
    stderr, exitCode: 1,
  });
  const agent = kind === 'grok' ? new GrokAdapter({ binary: binary.path }) : new CursorAdapter({ binary: binary.path });
  return { tmp, agent };
}

describe('terminal failure text at production callers', () => {
  it.each(CASES)('channel renders final guidance: $name', async ({ kind, stderr, message: terminalMessage, copy, snapshotReady }) => {
    const { tmp, agent } = await replay(kind, stderr, terminalMessage, snapshotReady);
    const cfg = createDefaultProfileConfig({ agentKind: kind,
      accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_synthetic'] },
      preferences: { messageReply: 'card', cotMessages: 'off' },
    });
    cfg.workspaces.default = tmp.workspace;
    const channel = createRecordingLarkChannel(); sdk.channel = channel;
    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
    const bridge = await startChannel({ cfg, agent, sessions, workspaces,
      controls: { profile: 'synthetic', profileConfig: cfg, cfg, ownerRefreshState: 'unknown',
        async refreshOwner() {}, async restart() {}, async exit() {},
        configPath: join(tmp.root, 'config.json'), processId: 'terminal-error-replay' },
    });
    cleanup.push(async () => { await bridge.disconnect(); await sessions.flush(); await workspaces.flush(); });
    await channel.handlers.message?.({ messageId: 'om_synthetic', content: 'Synthetic replay', chatId: 'oc_synthetic', chatType: 'p2p', senderId: 'ou_synthetic',
      senderName: 'Synthetic', rawContentType: 'text', resources: [], mentionedBot: false, createTime: Date.now(),
    } as unknown as NormalizedMessage);
    await vi.waitFor(() => expect(JSON.stringify(channel.sent)).toContain(copy), { timeout: 10000 });
    expect(JSON.stringify(channel.sent)).not.toContain('agent 运行失败');
  }, 15000);

  it.each(CASES)('RunExecutor records failure classification: $name', async ({ kind, stderr, message: terminalMessage, outcome, snapshotReady }) => {
    const { tmp, agent } = await replay(kind, stderr, terminalMessage, snapshotReady);
    const warn = vi.spyOn(log, 'warn');
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(),
      stderrSignatures: () => descriptorFor(kind).stderrSignatures,
    });
    const policy: RunPolicyAllow = { ok: true, prompt: 'Synthetic replay', requestedCwd: tmp.workspace, cwdRealpath: tmp.workspace,
      accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions', access: { ok: true, reason: 'allowed-user' },
      attachments: [], policyFingerprint: 'synthetic', expiresAt: Date.now() + 60000,
    };
    const execution = await executor.submit({ scopeId: 'synthetic', policy });
    const events = [];
    for await (const event of execution.subscribe()) events.push(event);
    await execution.finished;
    expect(execution.run.stderrSnapshot).toBe(stderr);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: terminalMessage }));
    expect(warn).toHaveBeenCalledWith('run', 'failed', expect.objectContaining({ outcome }));
  }, 15000);
});

it('preserves CRLF stderr from an executable in the runner terminal error', async () => {
  const tmp = await createTmpProfile('terminal-stderr-'); cleanup.push(tmp.cleanup);
  const binary = await writeScriptedJsonlExecutable(tmp.root, 'stderr-replay', {
    lines: [], stderr: 'first\r\nsecond\r\n', exitCode: 1,
  });
  const run = new GrokAdapter({ binary: binary.path }).run({ runId: 'stderr-replay', prompt: 'Synthetic replay', cwd: tmp.workspace });
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(await run.waitForExit(5000)).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'grok exited with code 1: first\nsecond' }));
}, 10000);
