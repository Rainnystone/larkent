import { parseFireKey } from '../../automations/schedule';
import { enqueueWakeRequest } from '../../automations/wake-file';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import { getServiceAdapter } from '../../daemon/service-adapter';
import { readAndPrune } from '../../runtime/registry';
import { runServiceStart } from './service';

export interface WakeStartOpts {
  profile: string;
  skipCheckLarkCli: boolean;
  webUi?: boolean;
}

export interface WakeCommandOptions {
  profile?: string;
  startIfStopped?: (opts: WakeStartOpts) => Promise<void>;
}

export async function runWake(fireKey: string, opts: WakeCommandOptions = {}): Promise<void> {
  if (!parseFireKey(fireKey)) throw new Error(`invalid fire key: ${fireKey}`);
  const profile = opts.profile ?? await resolveWakeProfile();
  const appPaths = resolveAppPaths({ profile });
  await enqueueWakeRequest(appPaths.automationsWakeDir, fireKey);
  if (isProfileBridgeRunning(profile)) return;
  // A live supervisor already holds the app lock. Its console token is random
  // per process, so this CLI cannot start a hosted profile. The wake file waits.
  if (isSupervisorServiceRunning()) return;
  const start = opts.startIfStopped ?? ((startOpts) => runServiceStart(startOpts));
  await start(wakeStartOpts(profile));
}

export function isProfileBridgeRunning(profile: string): boolean {
  if (readAndPrune().some((entry) => entry.profileName === profile)) return true;
  const classic = getServiceAdapter(profile);
  return Boolean(classic?.fileExists() && classic.isRunning());
}

export function wakeStartOpts(profile: string): WakeStartOpts {
  const classic = getServiceAdapter(profile);
  if (classic?.fileExists()) return { profile, skipCheckLarkCli: true };
  const supervisor = getServiceAdapter(SUPERVISOR_SERVICE_ID);
  if (supervisor?.fileExists()) return { profile, skipCheckLarkCli: true, webUi: true };
  return { profile, skipCheckLarkCli: true };
}

function isSupervisorServiceRunning(): boolean {
  const supervisor = getServiceAdapter(SUPERVISOR_SERVICE_ID);
  return Boolean(supervisor?.fileExists() && supervisor.isRunning());
}

async function resolveWakeProfile(): Promise<string> {
  const rootPaths = resolveAppPaths();
  const root = await loadRootConfig(rootPaths.configFile);
  const profile = (await readActiveProfile(rootPaths.rootDir)) ?? root?.activeProfile;
  if (!profile) throw new Error('active profile is required for wake; pass --profile <name>');
  return profile;
}
