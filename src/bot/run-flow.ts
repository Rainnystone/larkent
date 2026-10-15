import { descriptorFor } from '../agent/registry';
import { resolveModelArg } from '../agent/models';
import type { AgentCapability } from '../agent/capability';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  stopGraceMs?: number;
  /** `null` starts a fresh run; a string forces that resume handle. */
  forceResumeHandle?: string | null;
  /** When set, `forceResumeHandle` is ignored unless it matches the current policy. */
  forceResumeFingerprint?: string;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  const forceHandle = (
    typeof input.forceResumeHandle === 'string'
    && (
      input.forceResumeFingerprint === undefined
      || input.forceResumeFingerprint === policy.policyFingerprint
    )
  ) ? input.forceResumeHandle : undefined;
  if (input.forceResumeHandle === null) {
    resumeFrom = undefined;
  } else if (typeof forceHandle === 'string') {
    resumeFrom = forceHandle;
  } else {
    if (input.sessionCatalog) {
      const catalogEntry = input.sessionCatalog.activeFor({
        scopeId: input.scopeId,
        agentId: input.capability.agentId,
        cwdRealpath: workspace.cwdRealpath,
        policyFingerprint: policy.policyFingerprint,
      });
      resumeFrom = catalogEntry?.resumeHandle;
    }
    if (
      !resumeFrom
      && input.forceResumeFingerprint === undefined
      && descriptorFor(input.capability.agentId).resume.label === 'session'
    ) {
      resumeFrom = input.sessions.resumeFor(
        input.scopeId,
        workspace.cwdRealpath,
        input.profileConfig.agentKind,
      );
      const stale = input.sessions.getRaw(input.scopeId, input.profileConfig.agentKind);
      if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
        input.sessions.clear(input.scopeId, input.profileConfig.agentKind);
      }
    }
  }

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      resumeHandle: resumeFrom,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      images:
        descriptorFor(input.capability.agentId).acceptsImagePaths
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连。这条消息会在重连完成后补处理，请稍候。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system' || !input.event.resumeHandle) return;
  const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
  if (descriptorFor(input.capability.agentId).resume.label === 'session') {
    input.sessions.set(input.scopeId, input.event.resumeHandle, cwdRealpath, input.capability.agentId);
  }
  input.sessionCatalog?.upsertActive({
    scopeId: input.scopeId,
    agentId: input.capability.agentId,
    cwdRealpath,
    policyFingerprint: input.policy.policyFingerprint,
    resumeHandle: input.event.resumeHandle,
  });
}
