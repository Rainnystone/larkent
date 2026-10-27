import { bridgeToolInstructions } from '../bridge-tools/prompt';
import type { ToolRunContext } from '../bridge-tools/server';
import type { PluginCatalog } from '../plugins/catalog';
import { capabilityForProfile } from '../agent/capability';
import {
  cardUserMessage,
  matchCliSignature,
  type CliSignature,
} from '../agent/cli-signatures';
import { descriptorFor } from '../agent/registry';
import { buildAgentPrompt } from '../agent/prompt';
import type { AgentEvent } from '../agent/types';
import { noteRunEvent, type RunHandle } from '../bot/active-runs';
import { appendOutcomeNotice, finalReplyFor } from '../bot/cot';
import { createIdleWatchdog } from '../bot/idle-watchdog';
import { recordRunSessionEvent, startRunFlow } from '../bot/run-flow';
import {
  cardTerminalFromOutcome,
  describeRunOutcome,
  formatRunOutcome,
  noteTerminalStop,
  requestStop,
  shouldDeliverAgentEvent,
  type RunOutcome,
} from '../bot/run-outcome';
import {
  automationFollowUpScope,
  automationRunScope,
  isAutomationRunScope,
} from '../bot/scope';
import type { TurnJournal } from '../bot/turn-journal';
import {
  finalizeIfRunning,
  markIdleTimeout,
  markInterrupted,
  markRunnerTimeout,
  reduce,
  seedRunState,
  shouldSkipFinalReply,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import type { AppConfig } from '../config/schema';
import { getAgentStopGraceMs, getRunIdleTimeoutMs } from '../config/schema';
import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { canUseGroup, type OwnerRefreshState } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import {
  deliverAutomationMarkdown,
  fireTurnId,
  formatScheduledLabel,
  type AutomationDeliveryDeps,
} from './delivery';
import {
  inspectAutomationToolUse,
  policyGuardReasonLabel,
  type PolicyGuardReason,
} from './policy-guard';
import type { FireSend } from './scheduler';
import type { AutomationsStore } from './store';

export const AGENT_RESULT_FOOTER = '在本消息话题里追问';
export const AGENT_EMPTY_RESULT = '任务已完成，agent 没有给出文字结果。';
export const CATCH_UP_PROMPT_MARKER = '本次为补跑，原定 ';

export function formatCatchUpPromptHint(timezone: string, fireAt: number, now: number): string {
  return `${CATCH_UP_PROMPT_MARKER}${formatScheduledLabel(timezone, fireAt, now)}。请按原定任务执行。`;
}

export function formatAutomationAgentPrompt(
  fire: Pick<FireSend, 'chatId' | 'createdBy' | 'taskText' | 'catchUp' | 'timezone' | 'fireAt'>,
  now: number,
  botOpenId?: string,
  instructions?: string[],
): string {
  const userInput = fire.catchUp
    ? `${formatCatchUpPromptHint(fire.timezone, fire.fireAt, now)}\n\n${fire.taskText}`
    : fire.taskText;
  return buildAgentPrompt({
    instructions,
    context: {
      chatId: fire.chatId,
      chatType: 'group',
      senderId: fire.createdBy,
      source: 'im',
      ...(botOpenId ? { botOpenId } : {}),
    },
    userInput,
  });
}

export function formatAgentResultPost(input: {
  body: string;
  catchUp: boolean;
  timezone: string;
  fireAt: number;
  now: number;
  /** Completed and partial result posts invite a thread follow-up. Interrupt notices do not. */
  followUp?: boolean;
}): string {
  const lines = [input.body.trim()].filter((line) => line.length > 0);
  if (input.catchUp) {
    lines.push(`（补跑，原定 ${formatScheduledLabel(input.timezone, input.fireAt, input.now)}）`);
  }
  if (input.followUp !== false) lines.push(AGENT_RESULT_FOOTER);
  return lines.join('\n\n');
}

export function formatAgentFailureNotice(
  outcome: RunOutcome,
  meta: {
    now: number;
    catchUp?: boolean;
    timezone?: string;
    fireAt?: number;
    policyGuard?: PolicyGuardReason;
  },
): string {
  const dated = meta.catchUp === true
    && typeof meta.timezone === 'string'
    && meta.timezone.length > 0
    && typeof meta.fireAt === 'number';
  if (meta.catchUp === true && !dated) {
    log.warn('auto', 'catch-up-label-missing', {
      ...(meta.timezone !== undefined ? { timezone: meta.timezone } : {}),
      ...(meta.fireAt !== undefined ? { fireAt: meta.fireAt } : {}),
    });
  }
  return formatAgentResultPost({
    body: formatAgentFailureBody(outcome, meta.policyGuard),
    catchUp: dated,
    timezone: meta.timezone ?? '',
    fireAt: meta.fireAt ?? 0,
    now: meta.now,
    followUp: false,
  });
}

function formatAgentFailureBody(outcome?: RunOutcome, policyGuard?: PolicyGuardReason): string {
  if (outcome?.kind === 'interrupted' && outcome.reason.type === 'policy-guard') {
    const code = outcome.reason.code ?? (policyGuard === 'auth-config' ? policyGuard : undefined);
    const label = policyGuard ?? code;
    const reason = label ? `（${policyGuardReasonLabel(label)}${code ? `，${code}` : ''}）` : '';
    return `自动化任务中断：策略拦截${reason}。任务已暂停，可在看板恢复或删除。`;
  }
  return outcome
    ? `自动化任务中断：${describeRunOutcome(outcome)}`
    : '自动化任务中断：运行失败';
}

export function automationScopeForReply(
  journal: TurnJournal | undefined,
  msg: { threadId?: string; rootId?: string; replyToMessageId?: string },
): string | undefined {
  if (!journal) return undefined;
  const posts = new Map<string, string>();
  for (const entry of journal.list()) {
    if (!isAutomationRunScope(entry.scope)) continue;
    if (entry.outcome?.kind === 'interrupted' || entry.outcome?.kind === 'failed') continue;
    const id = entry.reply?.messageId?.trim();
    if (id) posts.set(id, entry.scope);
  }
  return automationFollowUpScope(
    [msg.threadId, msg.rootId, msg.replyToMessageId],
    posts,
  );
}

export interface AgentFireRuntime extends AutomationDeliveryDeps {
  executor: RunExecutor;
  pluginCatalog: PluginCatalog;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  profile: string;
  profileConfig: ProfileConfig;
  cfg: AppConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  automations?: AutomationsStore;
  pauseItem?: (id: number) => Promise<boolean>;
  botDisplayName?: () => string;
  onFireSettled?: () => void | Promise<void>;
}

export async function runAutomationAgentFire(
  fire: FireSend,
  runtime: AgentFireRuntime,
): Promise<void> {
  let status: 'ok' | 'failed' = 'failed';
  try {
    await runAutomationAgentFireBody(fire, runtime, (next) => {
      status = next;
    });
  } finally {
    await persistFireStatus(runtime, fire, status);
  }
}

async function runAutomationAgentFireBody(
  fire: FireSend,
  runtime: AgentFireRuntime,
  setStatus: (status: 'ok' | 'failed') => void,
): Promise<void> {
  const turnId = fireTurnId(fire.fireKey);
  const scope = automationRunScope(fire.id, fire.fireAt);
  const now = (runtime.now ?? Date.now)();
  const cwd = fire.cwd?.trim();
  if (!cwd) {
    noteUnanchored(runtime, fire, turnId, scope, {
      kind: 'failed',
      cause: 'unclassified',
      retriable: false,
      needsHuman: true,
    });
    await postFireMarkdown(runtime, fire, turnId, scope, '自动化任务中断：缺少工作目录', false);
    return;
  }
  runtime.workspaces.setCwd(scope, cwd);

  const toolContext: ToolRunContext = {
    catalog: runtime.pluginCatalog, profile: runtime.profile, chatId: fire.chatId, actorId: fire.createdBy,
    runType: 'automation', store: runtime.automations, journal: runtime.journal,
    timezone: runtime.profileConfig.automations.timezone, agentTasks: runtime.profileConfig.automations.agentTasks,
    cwd, now: runtime.now, availability: () => 'automation-management-unavailable-in-run',
  };
  const prompt = formatAutomationAgentPrompt(
    fire,
    now,
    runtime.botOpenId() || undefined,
    await bridgeToolInstructions(toolContext),
  );
  const journal = runtime.journal;
  if (journal && !journal.get(turnId)) {
    const actor = runtime.botOpenId();
    journal.enqueue({
      turnId,
      scope,
      chatId: fire.chatId,
      messageIds: [],
      senderId: actor,
      initiatorId: actor,
      initiatorType: 'bot',
      status: 'queued',
      userInput: prompt,
    });
    await journal.flush();
  }

  const access = canUseGroup(
    runtime.profileConfig,
    {
      ownerRefreshState: runtime.ownerRefreshState,
      ...(runtime.botOwnerId ? { botOwnerId: runtime.botOwnerId } : {}),
    },
    fire.chatId,
    fire.createdBy,
  );
  const capability = capabilityForProfile(runtime.profileConfig);
  let policyGuard: PolicyGuardReason | undefined;
  let flow: Awaited<ReturnType<typeof startRunFlow>>;
  try {
    flow = await startRunFlow({
      toolContext,
      scopeId: scope,
      scope: {
        source: 'im',
        chatId: fire.chatId,
        actorId: fire.createdBy,
      },
      prompt,
      attachments: [],
      access,
      capability,
      profileConfig: runtime.profileConfig,
      sessions: runtime.sessions,
      ...(runtime.sessionCatalog ? { sessionCatalog: runtime.sessionCatalog } : {}),
      workspaces: runtime.workspaces,
      executor: runtime.executor,
      now,
      cwdOverride: cwd,
      forceResumeHandle: null,
      bypassPool: true,
      promptVariant: 'automation',
      onEvent: (event, handle) => {
        if (handle.interrupted || event.type !== 'tool_use') return;
        const hit = inspectAutomationToolUse(event);
        if (!hit) return;
        requestStop(handle, { type: 'policy-guard', code: hit.reason });
        policyGuard = hit.reason;
        void handle.run.stop().catch(() => {});
      },
      stopGraceMs: getAgentStopGraceMs(runtime.cfg),
      observability: {
        profile: runtime.profile,
        agent: capability.agentId,
        source: 'automation',
        stage: 'submit',
      },
    });
  } catch {
    noteUnanchored(runtime, fire, turnId, scope, {
      kind: 'failed', cause: 'unclassified', retriable: false, needsHuman: true,
    });
    await postFireMarkdown(runtime, fire, turnId, scope, '自动化任务中断：运行启动失败', false);
    log.info('auto', 'result', { id: fire.id, fireAt: fire.fireAt, outcome: 'agent-start-failed' });
    return;
  }
  if (!flow.ok) {
    noteUnanchored(runtime, fire, turnId, scope, {
      kind: 'failed',
      cause: 'unclassified',
      retriable: false,
      needsHuman: true,
    });
    await postFireMarkdown(
      runtime,
      fire,
      turnId,
      scope,
      `自动化任务中断：${flow.rejectReason.userVisible}`,
      false,
    );
    log.info('auto', 'result', { id: fire.id, fireAt: fire.fireAt, outcome: flow.rejectReason.code });
    return;
  }

  const recordSession = (event: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions: runtime.sessions,
      ...(runtime.sessionCatalog ? { sessionCatalog: runtime.sessionCatalog } : {}),
      capability,
      policy: flow.policy,
      event,
    });
  };
  const state = await drainFireRun({
    handle: flow.execution.handle,
    events: flow.execution.subscribe(),
    idleTimeoutMs: getRunIdleTimeoutMs(runtime.cfg),
    recordSession,
    chatId: fire.chatId,
    scope,
    signatures: descriptorFor(runtime.profileConfig.agentKind).stderrSignatures.filter(
      (signature) => signature.classify.kind === 'partial',
    ),
  });
  const outcome = flow.execution.handle.outcome;
  if (policyGuard && runtime.automations) {
    await applyPolicyGuard(runtime, fire, policyGuard);
  }
  if (journal && outcome) journal.markSettled(turnId, outcome);
  log.info('auto', 'result', {
    id: fire.id,
    fireAt: fire.fireAt,
    outcome: outcome ? formatRunOutcome(outcome) : 'unknown',
  });

  if (shouldSkipFinalReply(state, fire.chatId)) {
    if (journal) {
      journal.noteCliAlreadySent(turnId);
      journal.replyDelivered(turnId);
      await journal.flush();
    }
    log.info('outbound', 'skip-cli-already-sent', {
      scope,
      chatId: fire.chatId,
      mode: 'text',
    });
    setStatus('ok');
    return;
  }

  let body = '';
  let followUp = false;
  if (outcome?.kind === 'interrupted' || outcome?.kind === 'failed') {
    body = formatAgentFailureBody(outcome, policyGuard);
  } else {
    const replied = finalReplyFor(state, {
      replyMode: descriptorFor(runtime.profileConfig.agentKind).replyMode,
      streamed: false,
    });
    const visible: RunState = {
      ...replied,
      blocks: replied.blocks.filter((block) => block.kind !== 'tool'),
    };
    body = renderText(visible).trim();
    if (!body && outcome && outcome.kind !== 'completed' && outcome.kind !== 'partial') {
      body = formatAgentFailureBody(outcome, policyGuard);
    } else {
      if (!body) body = AGENT_EMPTY_RESULT;
      setStatus('ok');
      followUp = true;
    }
  }
  await postFireMarkdown(runtime, fire, turnId, scope, body, followUp);
}

async function persistFireStatus(
  runtime: AgentFireRuntime,
  fire: FireSend,
  status: 'ok' | 'failed',
): Promise<void> {
  const store = runtime.automations;
  if (!store) return;
  try {
    if (!await store.settleFire(fire.id, status, fire.fireKey)) return;
    await store.writeStatus(runtime.botDisplayName?.() ?? 'bot');
    await runtime.onFireSettled?.();
  } catch (error) {
    log.fail('auto', error, { event: 'settle' });
  }
}

function noteUnanchored(
  runtime: AgentFireRuntime,
  fire: FireSend,
  turnId: string,
  scope: string,
  outcome: RunOutcome,
): void {
  const journal = runtime.journal;
  if (!journal) return;
  if (!journal.get(turnId)) {
    const actor = runtime.botOpenId();
    journal.enqueue({
      turnId,
      scope,
      chatId: fire.chatId,
      messageIds: [],
      senderId: actor,
      initiatorId: actor,
      initiatorType: 'bot',
      status: 'queued',
    });
  }
  journal.markSettled(turnId, outcome);
}

async function postFireMarkdown(
  runtime: AgentFireRuntime,
  fire: FireSend,
  turnId: string,
  scope: string,
  body: string,
  followUp: boolean,
): Promise<void> {
  if (!runtime.journal) return;
  await deliverAutomationMarkdown({
    kind: 'result',
    ...runtime,
    journal: runtime.journal,
    turnId,
    chatId: fire.chatId,
    scope,
    markdown: formatAgentResultPost({
      body,
      catchUp: fire.catchUp,
      timezone: fire.timezone,
      fireAt: fire.fireAt,
      now: (runtime.now ?? Date.now)(),
      followUp,
    }),
  });
}

async function applyPolicyGuard(
  runtime: AgentFireRuntime,
  fire: FireSend,
  reason: PolicyGuardReason,
): Promise<void> {
  const store = runtime.automations;
  if (!store) return;
  if (runtime.pauseItem) await runtime.pauseItem(fire.id);
  else await store.pause(fire.id);
  const decidedAt = (runtime.now ?? Date.now)();
  await store.recordLog({
    id: fire.id,
    taskType: fire.taskType,
    scheduledAt: fire.fireAt,
    decidedAt,
    result: 'policy-guard',
    reason,
  });
  log.info('auto', 'policy-guard', { id: fire.id, fireAt: fire.fireAt, reason });
  log.info('auto', 'paused', { id: fire.id });
}

async function drainFireRun(input: {
  handle: RunHandle;
  events: AsyncIterable<AgentEvent>;
  idleTimeoutMs: number | undefined;
  recordSession: (event: AgentEvent) => void;
  chatId: string;
  scope: string;
  signatures: readonly CliSignature[];
}): Promise<RunState> {
  let state = seedRunState({ currentChatId: input.chatId });
  let lastTerminal: AgentEvent | undefined;
  const watchdog = createIdleWatchdog({
    handle: input.handle,
    idleTimeoutMs: input.idleTimeoutMs,
    scope: input.scope,
  });
  try {
    for await (const event of input.events) {
      noteRunEvent(input.handle);
      if (!input.handle.interrupted) watchdog.noteDelivered(event);
      if (event.type === 'system') {
        input.recordSession(event);
        continue;
      }
      if (!shouldDeliverAgentEvent(input.handle, event)) continue;
      if (event.type === 'liveness') continue;
      if (event.type === 'done' || event.type === 'error') {
        lastTerminal = event;
        noteTerminalStop(input.handle, event);
      }
      state = reduce(state, event);
      if (state.terminal !== 'running') break;
    }
  } finally {
    watchdog.dispose();
  }

  const stderrTail = input.handle.run.stderrSnapshot
    ?? (lastTerminal?.type === 'error' ? lastTerminal.message : undefined);
  const matched = matchCliSignature(stderrTail, input.signatures);
  const outcome = input.handle.outcome;
  if (!outcome) throw new Error('run settled without an outcome');
  const userMessage = outcome.kind === 'partial' ? cardUserMessage(outcome, matched) : undefined;
  if (
    state.terminal === 'running'
    || cardTerminalFromOutcome(outcome) !== state.terminal
    || userMessage !== undefined
  ) {
    state = applyFireOutcome(state, outcome, watchdog.armedDelayMs(), userMessage);
  }
  if (input.handle.interrupted) await input.handle.run.stop();
  return state;
}

function applyFireOutcome(
  state: RunState,
  outcome: RunOutcome,
  idleTimeoutMs: number | undefined,
  userMessage?: string,
): RunState {
  const terminal = cardTerminalFromOutcome(outcome);
  switch (terminal) {
    case 'idle_timeout':
      return markIdleTimeout(state, Math.round((idleTimeoutMs ?? 0) / 60_000));
    case 'runner_timeout':
      return markRunnerTimeout(state);
    case 'interrupted':
      return markInterrupted(state);
    case 'error':
      return { ...state, terminal: 'error', footer: null };
    case 'done':
      return appendOutcomeNotice(finalizeIfRunning(state), userMessage);
    case 'running':
      return state;
    default: {
      const _exhaustive: never = terminal;
      return _exhaustive;
    }
  }
}
