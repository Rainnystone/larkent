import { descriptorFor, registeredAgentDescriptors, type AgentKind } from '../agent/registry';

export { resolveExecutablePath, resolveFirstAvailableBinary } from '../platform/executable';

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const descriptors = [...registeredAgentDescriptors].sort((a, b) => a.detectionOrder - b.detectionOrder);
  const detected: DetectedAgent[] = [];
  for (const descriptor of descriptors) {
    try {
      detected.push({
        kind: descriptor.kind,
        binaryPath: await descriptor.detectBinary(process.env[descriptor.envBinVar]),
      });
    } catch {}
  }
  return detected;
}

export async function resolveCursorBinary(): Promise<string> {
  const descriptor = descriptorFor('cursor');
  return descriptor.detectBinary(process.env[descriptor.envBinVar]);
}

export async function resolveCursorPathBinary(): Promise<string> {
  return descriptorFor('cursor').detectBinary();
}

export async function resolveEnvPinnedBinary(kind: AgentKind): Promise<string | undefined> {
  const descriptor = descriptorFor(kind);
  const command = process.env[descriptor.envBinVar];
  if (!command) return undefined;
  try {
    return await descriptor.detectBinary(command);
  } catch {
    return undefined;
  }
}
