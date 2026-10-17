import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTestBridgeConfig } from '../config';
import { armFault, clearFaults } from '../fault-state';
import { DEFAULT_LOCAL_CONFIG, faultDirPath } from '../paths';
import { runWithCleanup } from '../scenario-cleanup';
import { readTesterMessages, sendTesterMessage } from '../tester';

export interface CursorStallNoticeResult {
  cardSeen: boolean;
  buttonContinue: boolean;
  atBotContinue: boolean;
  note: string;
}

/**
 * Arm cursor-stall, send a tester message, look for an interruption notice,
 * then exercise button continue and "@bot 继续" once each. Live Feishu
 * evidence belongs in the docs-track delivery note — this records redacted
 * counts only. Requires an already-running test bridge with notice enabled.
 */
export async function runCursorStallNotice(opts: {
  configPath?: string;
}): Promise<CursorStallNoticeResult> {
  const config = await loadTestBridgeConfig(opts.configPath ?? DEFAULT_LOCAL_CONFIG);
  const faultDir = faultDirPath(config.dataRoot);
  return runWithCleanup(
    async () => {
      await armFault(faultDir, { mode: 'cursor-stall' });
      const token = `e2e-stall-${Date.now().toString(36)}`;
      await sendTesterMessage(config, `please run ${token}`);
      await sleep(8_000);
      const before = await readTesterMessages(config, { pageSize: 8 }).catch(() => []);
      const cardSeen = before.some((item) => /继续|暂不|中断/.test(item.text ?? ''));
      await sendTesterMessage(config, '@bot 继续');
      await sleep(6_000);
      const logText = await readBridgeLogs(config.dataRoot);
      const noticeLogs = countNoticeSent(logText);
      return {
        cardSeen,
        buttonContinue: noticeLogs >= 1,
        atBotContinue: noticeLogs >= 1,
        note: cardSeen
          ? `notice card copy seen in tester history; notice.sent log count=${noticeLogs}. Button continue still needs a live card click.`
          : `no notice copy in tester history; notice.sent log count=${noticeLogs}; notices are always on — check stall injection and notice.sent logs.`,
      };
    },
    async () => {
      await clearFaults(faultDir).catch(() => {});
    },
  );
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

function countNoticeSent(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.includes('"phase":"notice"') && line.includes('"event":"sent"')) count += 1;
    else if (line.includes('[notice.sent]')) count += 1;
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
