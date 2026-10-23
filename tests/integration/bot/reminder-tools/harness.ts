import type { buildToolProcess } from '../../../helpers/bridge-tool-process';
import { createAutomationToolHarness } from '../../../helpers/automation-tool-harness';
import { createRecordingLarkChannel, type RecordingLarkChannel } from '../../../helpers/recording-lark-channel';

export const NOW = Date.parse('2026-10-19T00:00:00Z'); // 08:00 Shanghai
export const FIRES = [1792371600000, 1792458000000, 1792544400000];
export const END = 1792598400000; // October 22 00:00 Shanghai, exclusive
export const schedule = { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: END };
export const reminder = { taskType: 'reminder', name: 'Synthetic reminder', taskText: 'Synthetic reminder body', schedule };

export function createReminderHarness(input: {
  getClient: () => Awaited<ReturnType<typeof buildToolProcess>>;
  cleanup: Array<() => Promise<unknown>>;
  setChannel: (channel: RecordingLarkChannel) => void;
}): (chatMode?: 'group' | 'topic', agentTasks?: boolean, journalMaxEntries?: number) => Promise<Awaited<ReturnType<typeof createAutomationToolHarness>>> {
  return (chatMode = 'group', agentTasks = false, journalMaxEntries) => createAutomationToolHarness({
    client: input.getClient(),
    cleanup: input.cleanup,
    setChannel: input.setChannel,
    initialNow: NOW,
    chatMode,
    agentTasks,
    journalMaxEntries,
  });
}

export function wrapListAsUserCardContent(channel: ReturnType<typeof createRecordingLarkChannel>): void {
  const orig = channel.rawClient.im.v1.message.list.bind(channel.rawClient.im.v1.message);
  channel.rawClient.im.v1.message.list = async (params: unknown) => {
    const result = await orig(params) as { data?: { items?: Array<Record<string, unknown>> } };
    const items = result.data?.items ?? [];
    return {
      ...result,
      data: {
        ...result.data,
        items: items.map((item) => {
          const body = item.body && typeof item.body === 'object' ? item.body as { content?: unknown } : undefined;
          if (typeof body?.content !== 'string') return item;
          let parsed: unknown;
          try { parsed = JSON.parse(body.content); } catch { return item; }
          const card = unwrapListedCard(parsed);
          if (!card) return item;
          return { ...item, msg_type: item.msg_type ?? 'interactive', body: { content: JSON.stringify(stripListedCallbacks(card)) } };
        }),
      },
    };
  };
}

function unwrapListedCard(parsed: unknown): object | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec.schema === '2.0') return rec;
  if (rec.card && typeof rec.card === 'object') return rec.card as object;
  return undefined;
}

function stripListedCallbacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripListedCallbacks);
  if (!value || typeof value !== 'object') return value;
  const rec = value as Record<string, unknown>;
  if (rec.tag === 'button') {
    return {
      tag: 'button',
      ...(typeof rec.element_id === 'string' ? { element_id: rec.element_id } : {}),
      ...(rec.text !== undefined ? { text: rec.text } : {}),
      ...(rec.type !== undefined ? { type: rec.type } : {}),
    };
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'behaviors' || key === 'value') continue;
    next[key] = stripListedCallbacks(child);
  }
  return next;
}
