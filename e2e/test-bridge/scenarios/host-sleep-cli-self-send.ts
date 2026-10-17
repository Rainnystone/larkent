import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTestBridgeConfig } from '../config';
import { DEFAULT_LOCAL_CONFIG } from '../paths';
import { freezeBridge } from '../driver';
import { readTesterMessages, sendTesterMessage, type ReadMessage } from '../tester';

export type LogOffsets = Record<string, number>;

export interface HostSleepCliSelfSendResult {
  skipCliAlreadySent: boolean;
  duplicateFinal: boolean;
  streamReconnectSeen: boolean;
  /** S7: SIGSTOP freeze is not OS sleep; must stay false on Linux. */
  hostSuspended: boolean;
  note: string;
}

/**
 * Process-freeze stand-in (SIGSTOP), not a real host sleep. Freeze the test
 * bridge while a turn is in flight, resume, then count whether the bridge
 * skipped its final reply after a self-sent inbound (own app, not in
 * outbound) and whether Cursor `connection`/`retry` was logged as
 * stream-reconnect instead of unknown_event.
 *
 * S7: a freeze must not set `hostSuspended` / review runs on Linux unless
 * `/proc/uptime` vs monotonic actually grew (it will not for SIGSTOP).
 * Real-sleep acceptance is a manual lid-close on the user's Mac.
 */
export async function runHostSleepCliSelfSend(opts: {
  configPath?: string;
  freezeMs?: number;
}): Promise<HostSleepCliSelfSendResult> {
  const config = await loadTestBridgeConfig(opts.configPath ?? DEFAULT_LOCAL_CONFIG);
  const freezeMs = clampFreeze(opts.freezeMs ?? 8_000);
  const token = `e2e-sleep-${Date.now().toString(36)}`;
  const logOffsets = await snapshotLogOffsets(config.dataRoot);
  const sentAtMs = Date.now();
  const sent = await sendTesterMessage(config, `please answer ${token}`);
  await sleep(1_500);
  await freezeBridge(config.dataRoot, true);
  await sleep(freezeMs);
  await freezeBridge(config.dataRoot, false);
  await sleep(10_000);

  const messages = await readTesterMessages(config, { pageSize: 12 }).catch(() => []);
  const finals = filterHostSleepFinals(messages, {
    token,
    triggerMessageId: sent.messageId,
    sentAtMs,
  });
  const logText = await readLogsSince(config.dataRoot, logOffsets);
  const skipCliAlreadySent = /skip-cli-already-sent|cli-self-send/.test(logText);
  const streamReconnectSeen = sawStreamReconnect(logText);
  const hostSuspended = sawHostSleepClassification(logText);
  return {
    skipCliAlreadySent,
    duplicateFinal: finals.length > 1,
    streamReconnectSeen,
    hostSuspended,
    note: [
      skipCliAlreadySent
        ? `skip-cli-already-sent or intake skip-self seen; tester finals=${finals.length}; stream-reconnect=${streamReconnectSeen}`
        : `no skip-cli-already-sent in logs; tester finals=${finals.length}; inspect WS redelivery vs CLI self-send (no ids).`,
      hostSuspended
        ? 'S7: logs classified this freeze as hostSuspended (unexpected for SIGSTOP on Linux).'
        : 'S7: freeze was not classified as host sleep; runs were not sleep-reviewed.',
    ].join(' '),
  };
}

export function filterHostSleepFinals(
  messages: readonly Pick<ReadMessage, 'messageId' | 'text' | 'createTime'>[],
  opts: { token: string; triggerMessageId?: string; sentAtMs: number },
): Array<Pick<ReadMessage, 'messageId' | 'text' | 'createTime'>> {
  return messages.filter((item) => {
    if (opts.triggerMessageId && item.messageId === opts.triggerMessageId) return false;
    const createdMs = messageTimeMs(item.createTime);
    if (createdMs !== undefined && createdMs < opts.sentAtMs) return false;
    const text = item.text ?? '';
    return text.includes(opts.token) || /e2e-fake-ok/.test(text);
  });
}

function messageTimeMs(createTime: string | undefined): number | undefined {
  if (createTime === undefined) return undefined;
  const n = Number(createTime);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n;
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

export async function snapshotLogOffsets(dataRoot: string): Promise<LogOffsets> {
  const offsets: LogOffsets = {};
  for (const file of await listBridgeLogFiles(dataRoot)) {
    try {
      offsets[file] = (await stat(file)).size;
    } catch {
      offsets[file] = 0;
    }
  }
  return offsets;
}

export async function readLogsSince(dataRoot: string, offsets: LogOffsets): Promise<string> {
  const files = new Set([...Object.keys(offsets), ...(await listBridgeLogFiles(dataRoot))]);
  const chunks: string[] = [];
  for (const file of files) {
    const chunk = await readFileFromOffset(file, offsets[file] ?? 0);
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks.join('\n');
}

/** True when Cursor connection/retry logged as stream-reconnect, not unknown_event on the same record. */
export function sawStreamReconnect(logText: string): boolean {
  return /stream-reconnect/.test(logText) && !sawUnknownConnectionOnSameRecord(logText);
}

/** S7: real OS sleep evidence, not a process freeze. */
export function sawHostSleepClassification(logText: string): boolean {
  return logText.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      const rec = JSON.parse(trimmed) as {
        phase?: string;
        event?: string;
        hostSuspended?: unknown;
      };
      if (rec.phase !== 'link') return false;
      if (rec.event === 'sleep') return true;
      return rec.event === 'recovered' && rec.hostSuspended === true;
    } catch {
      return /\[link\.sleep\]/.test(trimmed);
    }
  });
}

export function sawUnknownConnectionOnSameRecord(logText: string): boolean {
  return logText.split(/\r?\n/).some(
    (line) => line.includes('unknown_event') && /connection|retry/.test(line),
  );
}

async function listBridgeLogFiles(dataRoot: string): Promise<string[]> {
  const files: string[] = [];
  const stdout = join(dataRoot, 'test-bridge.stdout.log');
  try {
    await stat(stdout);
    files.push(stdout);
  } catch {
    // stdout capture is best-effort
  }
  const profiles = join(dataRoot, 'profiles');
  try {
    for (const profile of await readdir(profiles, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const logsDir = join(profiles, profile.name, 'logs');
      let names: string[] = [];
      try {
        names = await readdir(logsDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('bridge-') || !name.endsWith('.jsonl')) continue;
        files.push(join(logsDir, name));
      }
    }
  } catch {
    // no profiles yet
  }
  return files;
}

async function readFileFromOffset(file: string, offset: number): Promise<string> {
  try {
    const buf = await readFile(file);
    if (buf.length <= offset) return '';
    return buf.subarray(Math.max(0, offset)).toString('utf8');
  } catch {
    return '';
  }
}
