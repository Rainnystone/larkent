import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTestBridgeConfig } from '../config';
import { down, killCli, up } from '../driver';
import { armFault } from '../fault-state';
import { DEFAULT_LOCAL_CONFIG, faultDirPath } from '../paths';
import { readTesterMessages, sendTesterMessage } from '../tester';

export interface JournalKillGroupResult {
  recoveredLog: boolean;
  childSurvivedGroupKill: boolean | 'unknown';
  note: string;
}

/**
 * Hang an in-flight fake CLI, SIGTERM the bridge process group, restart, and
 * look for exactly-once `journal.recovered` in the local log. Live Feishu
 * evidence belongs in the docs-track delivery note — this records redacted
 * counts only.
 */
export async function runJournalKillGroup(opts: {
  configPath?: string;
  realCli?: boolean;
  startBridge?: boolean;
}): Promise<JournalKillGroupResult> {
  const config = await loadTestBridgeConfig(opts.configPath ?? DEFAULT_LOCAL_CONFIG);
  if (opts.startBridge) {
    await up({ config, realCli: opts.realCli === true });
  }
  await armFault(faultDirPath(config.dataRoot), { mode: 'hang', sticky: true });
  const token = `e2e-journal-${Date.now().toString(36)}`;
  await sendTesterMessage(config, `continue ${token}`);
  await sleep(2_000);
  await killCli(config.dataRoot, 'process-group');
  await sleep(1_000);
  await down(config.dataRoot).catch(() => {});
  await up({ config, realCli: opts.realCli === true });
  await sleep(8_000);
  const logText = await readBridgeLogs(config.dataRoot);
  const recovered = countJournalRecovered(logText);
  await readTesterMessages(config, { pageSize: 5 }).catch(() => []);
  return {
    recoveredLog: recovered === 1,
    childSurvivedGroupKill: 'unknown',
    note: recovered === 1
      ? 'journal.recovered appeared once after process-group kill and restart.'
      : `journal.recovered count=${recovered} after process-group kill and restart; inspect local logs.`,
  };
}

async function readBridgeLogs(dataRoot: string): Promise<string> {
  const chunks: string[] = [];
  try {
    chunks.push(await readFile(join(dataRoot, 'test-bridge.stdout.log'), 'utf8'));
  } catch {
    // stdout capture is best-effort
  }
  const profiles = join(dataRoot, 'profiles');
  try {
    for (const profile of await readdir(profiles, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const logsDir = join(profiles, profile.name, 'logs');
      let files: string[] = [];
      try {
        files = await readdir(logsDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.startsWith('bridge-') || !name.endsWith('.jsonl')) continue;
        try {
          chunks.push(await readFile(join(logsDir, name), 'utf8'));
        } catch {
          // skip unreadable log files
        }
      }
    }
  } catch {
    // no profiles yet
  }
  return chunks.join('\n');
}

function countJournalRecovered(text: string): number {
  let jsonl = 0;
  let stdout = 0;
  for (const line of text.split('\n')) {
    if (line.includes('"phase":"journal"') && line.includes('"event":"recovered"')) jsonl += 1;
    else if (line.includes('[journal.recovered]')) stdout += 1;
  }
  return jsonl > 0 ? jsonl : stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
