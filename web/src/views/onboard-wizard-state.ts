import type { AgentKind, OnboardAgentChoice, OnboardState } from "../lib/types";

export const EMPTY_AGENT_KINDS_ERROR = "agent 列表为空";

export type OnboardWizardSnapshot = {
  agentKinds: OnboardAgentChoice[];
  detected: AgentKind[];
  existing: string[];
  error: string | null;
};

export const EMPTY_ONBOARD_SNAPSHOT: OnboardWizardSnapshot = {
  agentKinds: [],
  detected: [],
  existing: [],
  error: null,
};

export function snapshotFromOnboardState(state: OnboardState): OnboardWizardSnapshot {
  return {
    agentKinds: state.agentKinds,
    detected: state.detectedAgents,
    existing: state.profiles,
    error: state.agentKinds.length === 0 ? EMPTY_AGENT_KINDS_ERROR : null,
  };
}

export function snapshotFromStateFetchError(error: unknown): OnboardWizardSnapshot {
  return {
    agentKinds: [],
    detected: [],
    existing: [],
    error: String((error as Error).message ?? error),
  };
}

export function mergeOnboardSnapshot(
  previous: OnboardWizardSnapshot,
  incoming: OnboardWizardSnapshot,
): OnboardWizardSnapshot {
  if (incoming.agentKinds.length > 0) return incoming;
  if (previous.agentKinds.length > 0) return previous;
  return incoming;
}

export async function loadOnboardWizardSnapshot(
  get: <T>(path: string) => Promise<T>,
): Promise<OnboardWizardSnapshot> {
  try {
    return snapshotFromOnboardState(await get<OnboardState>("/api/onboard/state"));
  } catch (error) {
    return snapshotFromStateFetchError(error);
  }
}
