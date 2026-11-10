import { printTimeoutMode } from '../agent/antigravity/options';
import { toolGraceMs } from '../bot/idle-watchdog';
import { log } from '../core/logger';

export const EFFECTIVE_ADAPTER_TIMING_KEYS = [
  'reason',
  'profile',
  'agentKind',
  'configPath',
  'printTimeoutMode',
  'printTimeout',
  'idleTimeoutMode',
  'idleTimeoutMs',
  'toolGraceMode',
  'toolGraceMs',
  'cliTimeoutSleep',
] as const;

export type EffectiveAdapterTimingReason = 'created' | 'run';

export type PrintTimeoutMode = 'omitted' | 'none' | 'configured' | 'unsupported';

export interface EffectiveAdapterTimingInput {
  profile?: string;
  agentKind: string;
  configPath?: string;
  printTimeout?: string;
  printTimeoutSupported?: boolean;
  idleTimeoutMs?: number;
}

export interface EffectiveAdapterTimingFields {
  profile?: string;
  agentKind: string;
  configPath?: string;
  printTimeoutMode: PrintTimeoutMode;
  printTimeout?: string;
  idleTimeoutMode: 'disabled' | 'configured';
  idleTimeoutMs?: number;
  toolGraceMode: 'disabled' | 'configured';
  toolGraceMs?: number;
  cliTimeoutSleep?: 'unverified';
}

export function effectiveAdapterTimingFields(
  input: EffectiveAdapterTimingInput,
): EffectiveAdapterTimingFields {
  const supported = input.printTimeoutSupported ?? input.agentKind === 'antigravity';
  const timeoutMode = resolvePrintTimeoutMode(supported, input.printTimeout);
  const idleTimeoutMs = input.idleTimeoutMs;
  const idleConfigured = idleTimeoutMs !== undefined;
  const fields: EffectiveAdapterTimingFields = {
    agentKind: input.agentKind,
    printTimeoutMode: timeoutMode,
    idleTimeoutMode: idleConfigured ? 'configured' : 'disabled',
    toolGraceMode: idleConfigured ? 'configured' : 'disabled',
  };
  if (input.profile) fields.profile = input.profile;
  if (input.configPath) fields.configPath = input.configPath;
  switch (timeoutMode) {
    case 'none':
    case 'configured':
      fields.printTimeout = input.printTimeout;
      break;
    case 'omitted':
    case 'unsupported':
      break;
    default: {
      const _never: never = timeoutMode;
      return _never;
    }
  }
  if (idleConfigured) {
    fields.idleTimeoutMs = idleTimeoutMs;
    fields.toolGraceMs = toolGraceMs(idleTimeoutMs);
  }
  if (timeoutMode === 'configured') fields.cliTimeoutSleep = 'unverified';
  return fields;
}

function resolvePrintTimeoutMode(
  supported: boolean,
  value: string | undefined,
): PrintTimeoutMode {
  if (!supported) return 'unsupported';
  const mode = printTimeoutMode(value);
  switch (mode) {
    case 'omitted':
    case 'none':
    case 'configured':
      return mode;
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

export function logEffectiveAdapterTiming(
  reason: EffectiveAdapterTimingReason,
  input: EffectiveAdapterTimingInput & Record<string, unknown>,
): void {
  const fields = effectiveAdapterTimingFields(input);
  const logged: Record<string, unknown> = { reason };
  for (const key of EFFECTIVE_ADAPTER_TIMING_KEYS) {
    if (key === 'reason') continue;
    const value = fields[key as keyof EffectiveAdapterTimingFields];
    if (value !== undefined) logged[key] = value;
  }
  log.info('adapter', 'effective-timing', logged);
}
