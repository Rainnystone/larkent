import { expect, it, vi } from 'vitest';
import { requestBridgeTool } from '../../../src/bridge-tools/client';

it('reports a definite no-active-run for writes without synthesizing an operation ID', async () => {
  const result = await requestBridgeTool({
    version: 1,
    operation: 'automation.create',
    params: {
      taskType: 'reminder',
      name: 'Synthetic reminder',
      taskText: 'Synthetic reminder body',
      schedule: { kind: 'one-shot', fireAt: 1_760_000_600_000 },
    },
  }, { LARK_BRIDGE_TOOL_ENDPOINT: '', LARK_BRIDGE_TOOL_TOKEN: '' });
  expect(result).toEqual({ version: 1, category: 'unavailable', code: 'no-active-run' });
});

// Exercise the request boundary without real network calls or ten-second waits.
const activeEnv = {
  LARK_BRIDGE_TOOL_ENDPOINT: 'http://127.0.0.1:12345/tool',
  LARK_BRIDGE_TOOL_TOKEN: 'synthetic-test-token',
};

it.each([
  [undefined, 10_000], ['', 10_000], ['0', 10_000], ['-1', 10_000],
  ['not-a-number', 10_000], ['Infinity', 10_000], ['1.5', 10_000],
  ['2147483648', 10_000], ['4294967296', 10_000],
  ['1', 1], ['60000', 60_000], ['120000', 120_000], ['2147483647', 2_147_483_647],
])('uses a safe timeout for override %s', async (value, expected) => {
  const signal = new AbortController().signal;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: 1, category: 'ok', code: 'ok' }) });
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(await requestBridgeTool({ operation: 'plugins.list' }, { ...activeEnv, LARK_BRIDGE_TOOL_TIMEOUT_MS: value })).toMatchObject({ category: 'ok' });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it.each(['plugins.list', 'automation.create'])('preserves timeout result semantics for %s at the default budget', async operation => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  })));
  try {
    const pending = requestBridgeTool({ operation, params: {} }, activeEnv);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ category: operation === 'automation.create' ? 'unknown' : 'unavailable', code: 'run-connection-closed' });
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
