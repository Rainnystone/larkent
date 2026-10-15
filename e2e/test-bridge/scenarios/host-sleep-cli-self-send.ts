import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTestBridgeConfig } from '../config';
import { DEFAULT_LOCAL_CONFIG } from '../paths';
import { freezeBridge } from '../driver';
import { readTesterMessages, sendTesterMessage } from '../tester';

export interface HostSleepCliSelfSendResult {
  skipCliAlreadySent: boolean;
  duplicateFinal: boolean;
  streamReconnectSeen: boolean;
  note: string;
}

/**
 * Host-sleep / reconnect mid-run with a CLI self-send. Freeze the test
 * bridge (SIGSTOP) while a turn is in flight, resume, then count whether
 * the bridge skipped its final reply after a self-sent inbound (own app,
 * not in outbound) and whether Cursor `connection`/`retry` was logged as
 * stream-reconnect instead of unknown_event. Live Feishu evidence belongs
 * in the docs-track delivery note — this records redacted counts only.
 */
export async function runHostSleepCliSelfSend(opts: {
  configPath?: string;
  freezeMs?: number;
}): Promise<HostSleepCliSelfSendResult> {
  const config = await loadTestBridgeConfig(opts.configPath ?? DEFAULT_LOCAL_CONFIG);
  const freezeMs = clampFreeze(opts.freezeMs ?? 8_000);
  const token = `e2e-sleep-${Date.now().toString(36)}`;
  await sendTesterMessage(config, `please answer ${token}`);
  await sleep(1_500);
  await freezeBridge(config.dataRoot, true);
  await sleep(freezeMs);
  await freezeBridge(config.dataRoot, false);
  await sleep(10_000);

  const messages = await readTesterMessages(config, { pageSize: 12 }).catch(() => []);
  const finals = messages.filter((item) => (item.text ?? '').includes(token) || /e2e-fake-ok/.test(item.text ?? ''));
  const logText = await readBridgeLogs(config.dataRoot);
  const skipCliAlreadySent = /skip-cli-already-sent|cli-self-send/.test(logText);
  const streamReconnectSeen = /stream-reconnect/.test(logText);
  const unknownConnection = /unknown_event/.test(logText) && /connection|retry/.test(logText);
  return {
    skipCliAlreadySent,
    duplicateFinal: finals.length > 1,
    streamReconnectSeen: streamReconnectSeen && !unknownConnection,
    note: skipCliAlreadySent
      ? `skip-cli-already-sent or intake skip-self seen; tester finals=${finals.length}; stream-reconnect=${streamReconnectSeen}`
      : `no skip-cli-already-sent in logs; tester finals=${finals.length}; inspect WS redelivery vs CLI self-send (no ids).`,
  };
}

function clampFreeze(ms: number): number {
  if (!Number.isFinite(ms)) return 8_000;
  return Math.min(30_000, Math.max(3_000, ms));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
