import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterHostSleepFinals,
  readLogsSince,
  sawHostSleepClassification,
  sawStreamReconnect,
  sawUnknownConnectionOnSameRecord,
  snapshotLogOffsets,
} from '../../e2e/test-bridge/scenarios/host-sleep-cli-self-send';

const TOKEN = 'e2e-sleep-abc';
const SENT_AT = 1_760_000_000_000;

describe('filterHostSleepFinals', () => {
  it('excludes the tester trigger by message id and older history', () => {
    const finals = filterHostSleepFinals(
      [
        { messageId: 'om_old', text: `please answer ${TOKEN}`, createTime: String(SENT_AT - 60_000) },
        { messageId: 'om_trigger', text: `please answer ${TOKEN}`, createTime: String(SENT_AT) },
        { messageId: 'om_bot', text: `e2e-fake-ok ${TOKEN}`, createTime: String(SENT_AT + 2_000) },
        { messageId: 'om_dup', text: `e2e-fake-ok ${TOKEN}`, createTime: String(SENT_AT + 3_000) },
      ],
      { token: TOKEN, triggerMessageId: 'om_trigger', sentAtMs: SENT_AT },
    );
    expect(finals.map((item) => item.messageId)).toEqual(['om_bot', 'om_dup']);
  });

  it('does not treat a single bot reply as a duplicate', () => {
    const finals = filterHostSleepFinals(
      [
        { messageId: 'om_trigger', text: `please answer ${TOKEN}`, createTime: String(SENT_AT) },
        { messageId: 'om_bot', text: 'e2e-fake-ok', createTime: String(SENT_AT + 1_000) },
      ],
      { token: TOKEN, triggerMessageId: 'om_trigger', sentAtMs: SENT_AT },
    );
    expect(finals).toHaveLength(1);
  });
});

describe('readLogsSince', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function makeDataRoot(): Promise<{ root: string; jsonl: string }> {
    const root = await mkdtemp(join(tmpdir(), 'e2e-host-sleep-logs-'));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
    const logsDir = join(root, 'profiles', 'claude', 'logs');
    await mkdir(logsDir, { recursive: true });
    return { root, jsonl: join(logsDir, 'bridge-20261015.jsonl') };
  }

  it('returns only bytes appended after the snapshot', async () => {
    const { root, jsonl } = await makeDataRoot();
    const prior = '{"phase":"jsonl","event":"unknown_event","eventType":"connection"}\n';
    await writeFile(jsonl, prior);
    const offsets = await snapshotLogOffsets(root);
    const appended = '{"phase":"jsonl","event":"stream-reconnect","eventType":"retry"}\n';
    await writeFile(jsonl, prior + appended);
    const since = await readLogsSince(root, offsets);
    expect(since).toBe(appended);
    expect(sawUnknownConnectionOnSameRecord(since)).toBe(false);
    expect(sawStreamReconnect(since)).toBe(true);
  });

  it('reads a jsonl file created after the snapshot', async () => {
    const { root, jsonl } = await makeDataRoot();
    const offsets = await snapshotLogOffsets(root);
    const line = '{"phase":"jsonl","event":"stream-reconnect","eventType":"connection"}\n';
    await writeFile(jsonl, line);
    expect(await readLogsSince(root, offsets)).toBe(line);
  });
});

describe('S7 freeze is not host sleep', () => {
  it('does not treat a SIGSTOP freeze recovered log as reviewed on Linux', () => {
    const freeze = [
      '{"phase":"link","event":"tick-gap","gapMs":8000}',
      '{"phase":"link","event":"recovered","hostSuspended":false}',
    ].join('\n');
    expect(sawHostSleepClassification(freeze)).toBe(false);
  });

  it('treats link.sleep or hostSuspended recovered as real sleep evidence', () => {
    expect(sawHostSleepClassification(
      '{"phase":"link","event":"sleep","sleptMs":60000}',
    )).toBe(true);
    expect(sawHostSleepClassification(
      '{"phase":"link","event":"recovered","hostSuspended":true}',
    )).toBe(true);
  });
});

describe('sawUnknownConnectionOnSameRecord', () => {
  it('requires unknown_event and connection/retry on the same JSONL record', () => {
    const split = [
      '{"phase":"jsonl","event":"unknown_event","eventType":"tool_call:x"}',
      '{"phase":"jsonl","event":"stream-reconnect","eventType":"connection"}',
    ].join('\n');
    expect(sawUnknownConnectionOnSameRecord(split)).toBe(false);
    expect(sawStreamReconnect(split)).toBe(true);

    const same = '{"phase":"jsonl","event":"unknown_event","eventType":"connection"}';
    expect(sawUnknownConnectionOnSameRecord(same)).toBe(true);
    expect(sawStreamReconnect(`${same}\n{"event":"stream-reconnect"}`)).toBe(false);
  });
});
