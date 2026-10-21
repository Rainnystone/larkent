import type { ClientContext, LoadSessionResponse, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import { DEVIN_DEFAULT_PERMISSION_MODE, parseDevinAgentOptions, type DevinPermissionMode } from './options';
import { asAgentOptionsObject, runAgentOptions, type AgentRunOptions, type EffectiveAccess } from '../types';

export interface DevinRunConfig { sandbox: boolean; mode: DevinPermissionMode; access: EffectiveAccess }
const ranks = { auto: 0, 'accept-edits': 1, smart: 2, dangerous: 3, autonomous: 3 } as const;

/** Profile-native options and generic policy hints occupy different namespaces. */
export function resolveDevinRunConfig(profile: unknown, run: AgentRunOptions): DevinRunConfig {
  const base = parseDevinAgentOptions(profile, true);
  const raw = asAgentOptionsObject(runAgentOptions(run), 'devin');
  const hints = parseDevinAgentOptions(raw);
  let mode = hints.permissionMode ?? base.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE;
  const nativeSandbox = typeof raw.sandbox === 'boolean' ? raw.sandbox : base.sandbox;
  const sandbox = (nativeSandbox ?? inheritedSandbox()) || base.permissionMode === 'autonomous' || raw.permissionMode === 'autonomous';
  const access: EffectiveAccess = raw.sandbox === 'read-only' || raw.permissionMode === 'plan' ? 'read-only'
    : raw.sandbox === 'workspace-write' || ['acceptEdits', 'default'].includes(String(raw.permissionMode)) ? 'workspace' : 'full';
  // A policy hint may narrow the profile; it cannot replace a stricter preference.
  if (base.permissionMode && ranks[base.permissionMode] < ranks[mode]) mode = base.permissionMode;
  if (access === 'read-only') mode = 'auto';
  else if (access === 'workspace' && ranks[mode] > 1 && !sandbox) mode = 'accept-edits';
  if (sandbox && access !== 'read-only' && [base.permissionMode, raw.permissionMode].some(m => m === 'smart' || m === 'accept-edits')) {
    throw new Error('Devin sandbox cannot preserve the requested restricted permission mode');
  }
  return { sandbox, mode, access };
}

function inheritedSandbox(): boolean {
  const value = process.env.DEVIN_SANDBOX?.toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new Error('Invalid DEVIN_SANDBOX environment value; expected true/false');
}

export async function configureDevinSession(agent: ClientContext, sessionId: string, state: LoadSessionResponse, config: DevinRunConfig, model?: string): Promise<void> {
  let options = state.configOptions ?? undefined;
  const mode = config.sandbox ? (config.mode === 'auto' || config.access === 'read-only' ? 'plan' : 'autonomous')
    : ({ auto: 'ask', 'accept-edits': 'accept-edits', smart: 'smart', dangerous: 'bypass', autonomous: 'bypass' } as const)[config.mode];
  if (config.sandbox && ['smart', 'accept-edits'].includes(config.mode) && config.access === 'full') {
    throw new Error('Devin sandbox cannot preserve the requested restricted permission mode');
  }
  if (options !== undefined) {
    const selector = options.find(o => o.category === 'mode' || o.id === 'mode');
    if (!selector || !choices(selector).some(o => o.value === mode)) throw new Error(`Devin cannot apply permission mode ${mode}`);
    await set(selector.id, mode);
  } else {
    if (!state.modes?.availableModes.some(m => m.id === mode)) throw new Error(`Devin cannot apply permission mode ${mode}`);
    await agent.request('session/set_mode', { sessionId, modeId: mode });
  }
  if (!model) return;
  const selector = options?.find(o => o.category === 'model');
  if (!selector) throw new Error('Devin does not advertise model configuration');
  const models = choices(selector);
  const exact = models.find(o => o.value === model);
  const alias = model === 'opus' || model === 'sonnet'
    ? models.find(o => o.value.startsWith(`claude-${model}-`))
    : model === 'swe-2-max' ? models.find(o => o.value.startsWith('swe-2-')) : undefined;
  const selected = exact ?? alias;
  if (!selected) throw new Error(`Devin model unavailable: ${model}`);
  await set(selector.id, selected.value);
  if (model === 'swe-2-max' && !exact) {
    const thinking = options?.find(o => o.category === 'thought_level');
    if (!thinking || !choices(thinking).some(o => o.value === 'max')) throw new Error('Devin does not support SWE-2 max thinking');
    await set(thinking.id, 'max');
  }

  async function set(configId: string, value: string): Promise<void> {
    const response = await agent.request('session/set_config_option', { sessionId, configId, value });
    options = response.configOptions;
    if (!options.some(o => o.id === configId && o.currentValue === value)) throw new Error(`Devin did not apply ${configId}=${value}`);
  }
}

function choices(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap(o => 'options' in o ? o.options : [o]);
}
