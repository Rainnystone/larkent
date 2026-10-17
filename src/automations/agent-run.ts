import { capabilityForProfile } from '../agent/capability';
import type { AgentEvent } from '../agent/types';
import { noteRunEvent, type RunHandle } from '../bot/active-runs';
import { recordRunSessionEvent, startRunFlow } from '../bot/run-flow';
import {
  cardTerminalFromOutcome,
  deriveRunOutcome,
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
  formatScheduledHm,
  type AutomationDeliveryDeps,
} from './delivery';
import { inspectAutomationToolUse, type PolicyGuardReason } from './policy-guard';
import type { FireSend } from './scheduler';
import type { AutomationsStore } from './store';

export const AGENT_RESULT_FOOTER = '在本消息话题里追问';

export function formatCatchUpPromptHint(timezone: string, fireAt: number): string {
  return `本次为补跑，原定 ${formatScheduledHm(timezone, fireAt)}。请按原定任务执行。`;
}

export function formatAgentResultPost(input: {
  body: string;
  catchUp: boolean;
  timezone: string;
  fireAt: number;
}): string {
  const lines = [input.body.trim()].filter((line) => line.length > 0);
  if (input.catchUp) {
    lines.push(`（补跑，原定 ${formatScheduledHm(input.timezone, input.fireAt)}）`);
  }
  lines.push(AGENT_RESULT_FOOTER);
  return lines.join('\n\n');
}

export function formatAgentFailureNotice(outcome: RunOutcome): string {
  return formatAgentResultPost({
    body: formatAgentFailureBody(outcome),
    catchUp: false,
    timezone: 'UTC',
    fireAt: 0,
  });
}

function formatAgentFailureBody(outcome?: RunOutcome): string {
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
}

export async function runAutomationAgentFire(
  fire: FireSend,
  runtime: AgentFireRuntime,
): Promise<void> {
  const turnId = fireTurnId(fire.fireKey);
  const scope = automationRunScope(fire.id, fire.fireAt);
  const now = (runtime.now ?? Date.now)();
  const cwd = fire.cwd?.trim();
  if (!cwd) {
    await postFireMarkdown(runtime, fire, turnId, scope, '自动化任务中断：缺少工作目录');
    return;
  }
  runtime.workspaces.setCwd(scope, cwd);

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
      userInput: fire.taskText,
    });
    await journal.flush();
  }

  const prompt = fire.catchUp
    ? `${formatCatchUpPromptHint(fire.timezone, fire.fireAt)}\n\n${fire.taskText}`
    : fire.taskText;
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
  const flow = await startRunFlow({
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
    stopGraceMs: getAgentStopGraceMs(runtime.cfg),
    observability: {
      profile: runtime.profile,
      agent: capability.agentId,
      source: 'automation',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    await postFireMarkdown(
      runtime,
      fire,
      turnId,
      scope,
      `自动化任务中断：${flow.rejectReason.userVisible}`,
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
  const { state, policyGuard } = await drainFireRun({
    handle: flow.execution.handle,
    events: flow.execution.subscribe(),
    idleTimeoutMs: getRunIdleTimeoutMs(runtime.cfg),
    recordSession,
    chatId: fire.chatId,
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
    return;
  }

  let body = '';
  if (outcome?.kind === 'interrupted' || outcome?.kind === 'failed') {
    body = formatAgentFailureBody(outcome);
  } else {
    const visible: RunState = {
      ...state,
      blocks: state.blocks.filter((block) => block.kind !== 'tool'),
    };
    body = renderText(visible).trim();
    if (!body && outcome && outcome.kind !== 'completed' && outcome.kind !== 'partial') {
      body = formatAgentFailureBody(outcome);
    }
  }
  await postFireMarkdown(runtime, fire, turnId, scope, body);
}

async function postFireMarkdown(
  runtime: AgentFireRuntime,
  fire: FireSend,
  turnId: string,
  scope: string,
  body: string,
): Promise<void> {
  if (!runtime.journal) return;
  await deliverAutomationMarkdown({
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
}): Promise<{ state: RunState; policyGuard?: PolicyGuardReason }> {
  let state = seedRunState({ currentChatId: input.chatId });
  let lastTerminal: AgentEvent | undefined;
  let timer: NodeJS.Timeout | undefined;
  const clearIdleTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const armIdleWatchdog = (): void => {
    clearIdleTimer();
    if (!input.idleTimeoutMs) return;
    timer = setTimeout(() => {
      requestStop(input.handle, { type: 'bridge-idle-watchdog' });
      log.warn('agent', 'idle-timeout', { idleTimeoutMs: input.idleTimeoutMs });
      void input.handle.run.stop().catch(() => {});
    }, input.idleTimeoutMs);
  };
  armIdleWatchdog();
  let policyGuard: PolicyGuardReason | undefined;
  try {
    for await (const event of input.events) {
      noteRunEvent(input.handle);
      if (event.type === 'system') {
        input.recordSession(event);
        if (!input.handle.interrupted) armIdleWatchdog();
        continue;
      }
      if (!shouldDeliverAgentEvent(input.handle, event)) continue;
      if (event.type === 'tool_use') {
        const hit = inspectAutomationToolUse(event);
        if (hit) {
          requestStop(input.handle, { type: 'policy-guard' });
          policyGuard = hit.reason;
          void input.handle.run.stop().catch(() => {});
          break;
        }
      }
      armIdleWatchdog();
      if (event.type === 'done' || event.type === 'error') {
        lastTerminal = event;
        noteTerminalStop(input.handle, event);
      }
      state = reduce(state, event);
      if (state.terminal !== 'running') break;
    }
  } finally {
    clearIdleTimer();
  }

  const outcome = deriveRunOutcome({
    stopRequest: input.handle.stopRequest,
    terminalEvent: lastTerminal,
    exit: input.handle.run.exit,
    signal: input.handle.run.signal,
    stderrTail: input.handle.run.stderrSnapshot
      ?? (lastTerminal?.type === 'error' ? lastTerminal.message : undefined),
  });
  if (
    state.terminal === 'running'
    || cardTerminalFromOutcome(outcome) !== state.terminal
  ) {
    state = applyFireOutcome(state, outcome, input.idleTimeoutMs);
  }
  input.handle.outcome = outcome;
  if (input.handle.interrupted) await input.handle.run.stop();
  return policyGuard ? { state, policyGuard } : { state };
}

function applyFireOutcome(
  state: RunState,
  outcome: RunOutcome,
  idleTimeoutMs: number | undefined,
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
      return finalizeIfRunning(state);
    case 'running':
      return state;
    default: {
      const _exhaustive: never = terminal;
      return _exhaustive;
    }
  }
}
