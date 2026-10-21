import { expect, it } from 'vitest';
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
