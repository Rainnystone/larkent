import { seedDraftDelivery } from '../../helpers/draft-delivery-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getAutomationOperation } from '../../../src/automations/operation';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { AutomationsStore } from '../../../src/automations/store';
import type { AutomationToolContext } from '../../../src/automations/tools';

const NOW = 1_760_000_000_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it.each(['prepared', 'unattempted'] as const)('reports an unsent %s draft as pending unknown, not a terminal card-not-sent', async state => {
  const { context, operationId } = await fixture();
  const draft = context.store!.listDrafts()[0]!;
  if (state === 'prepared') {
    await seedDraftDelivery(context.store!, draft.draftId, {
      state: 'prepared',
      deliveryId: 'ab'.repeat(16),
      card: { synthetic: true },
    });
  }
  expect(await getAutomationOperation(operationId, context)).toMatchObject({
    category: 'unknown',
    code: 'card-not-sent',
    data: { operationId, state: 'unknown', applied: null },
  });
});

it('still reports a rejected card send as not-applied', async () => {
  const { context, operationId } = await fixture();
  const draft = context.store!.listDrafts()[0]!;
  await seedDraftDelivery(context.store!, draft.draftId, {
    state: 'rejected',
    deliveryId: 'cd'.repeat(16),
    card: { synthetic: true },
  });
  expect(await getAutomationOperation(operationId, context)).toMatchObject({
    category: 'execution-failed',
    code: 'card-send-failed',
    data: { operationId, state: 'not-applied', applied: false },
  });
});

async function fixture(): Promise<{ context: AutomationToolContext; operationId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'operation-result-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW,
  });
  await store.load();
  const profile = 'synthetic';
  const chatId = 'oc_synthetic';
  const operationId = newAutomationOperationId(automationOperationScope(profile, chatId), NOW);
  await store.saveDraft({
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW + 600_000,
    endAt: NOW + 600_000,
    nextFireAt: NOW + 600_000,
    chatId,
    createdBy: 'ou_synthetic',
    name: 'Synthetic reminder',
    taskText: 'Synthetic reminder body',
    operationId,
  }, { operationId, profile, chatId, fingerprint: 'ab'.repeat(32) });
  return {
    operationId,
    context: {
      profile,
      chatId,
      actorId: 'ou_synthetic',
      runType: 'im',
      availability: () => undefined,
      store,
      timezone: 'Asia/Shanghai',
      agentTasks: false,
      now: () => NOW,
    },
  };
}
