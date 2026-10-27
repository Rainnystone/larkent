import { bridgeToolInstructions } from '../bridge-tools/prompt';
import type { ToolRunContext } from '../bridge-tools/server';
import type { PluginCatalog } from '../plugins/catalog';
import { capabilityForProfile } from '../agent/capability';
import { buildAgentPrompt } from '../agent/prompt';
import { executeTurn, TurnStartFailed, type TurnResult } from '../bot/turn';
import {
  describeRunOutcome,
  formatRunOutcome,
  type RunOutcome,
} from '../bot/run-outcome';
import {
  automationFollowUpScope,
  automationRunScope,
  isAutomationRunScope,
} from '../bot/scope';
import type { TurnJournal } from '../bot/turn-journal';
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
  automationOutbox,
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
  let flow: TurnResult;
  try {
    flow = await executeTurn({
      run: {
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
        stopGraceMs: getAgentStopGraceMs(runtime.cfg),
        observability: {
          profile: runtime.profile,
          agent: capability.agentId,
          source: 'automation',
          stage: 'submit',
        },
      },
      idleTimeoutMs: getRunIdleTimeoutMs(runtime.cfg),
      onToolUse: event => {
        const hit = inspectAutomationToolUse(event);
        if (!hit) return;
        policyGuard = hit.reason;
        return { type: 'policy-guard', code: hit.reason };
      },
      delivery: {
        onResult: ok => { if (ok) setStatus('ok'); },
        onSettled: async outcome => {
          if (policyGuard && runtime.automations) await applyPolicyGuard(runtime, fire, policyGuard);
          log.info('auto', 'result', { id: fire.id, fireAt: fire.fireAt, outcome: formatRunOutcome(outcome) });
        },
        kind: 'automation', outbox: automationOutbox(runtime), journal, turnId, chatId: fire.chatId,
        actor: runtime.botOpenId(), emptyResult: AGENT_EMPTY_RESULT,
        failureBody: outcome => formatAgentFailureBody(outcome, policyGuard),
        formatPost: (body, followUp) => formatAgentResultPost({
          body, catchUp: fire.catchUp, timezone: fire.timezone, fireAt: fire.fireAt,
          now: (runtime.now ?? Date.now)(), followUp,
        }),
      },
    });
  } catch (error) {
    if (!(error instanceof TurnStartFailed)) throw error;
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
