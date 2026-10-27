import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { submitDraft, flushDraftConfirmations } from '../../../src/automations/draft-confirmation';
import { AutomationsStore, type SaveAutomationDraftInput } from '../../../src/automations/store';
import { Outbox } from '../../../src/bot/outbox';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const NOW = Date.UTC(2026, 9, 18, 3);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('submits one confirmation through the real Outbox and concurrent flushes leave one visible card', async () => {
  const h = await harness();
  const draft = await submitDraft(h.ctx, reminder());
  await Promise.all([flushDraftConfirmations(h.ctx), flushDraftConfirmations(h.ctx, draft.draftId)]);
  expect(h.channel.sent).toHaveLength(1);
  expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('auto.confirm');
  expect(h.channel.sent[0]?.options).toMatchObject({ uuid: expect.any(String) });
});

function reminder(): SaveAutomationDraftInput {
  return { taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 900_000, timezone: 'UTC' },
    timezone: 'UTC', startAt: NOW, endAt: NOW + 900_000, nextFireAt: NOW + 900_000,
    chatId: 'oc_group', createdBy: 'ou_user', name: 'Review', taskText: 'Review the plan' };
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'draft-confirmation-')); dirs.push(dir);
  const store = new AutomationsStore({ path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => NOW });
  const channel = createRecordingLarkChannel();
  const autoAuth = new AutoActionAuth({ secret: 'test-secret', nonceStore: new CallbackNonceStore(join(dir, 'nonces.json')), now: () => NOW });
  store.draftOutbox = new Outbox({ channel: channel as never, journal: store.outboxJournal, draftCards: store, botAppId: 'cli_test', liveSweep: false });
  return { store, channel, ctx: { automations: store, autoAuth, channel: channel as never, now: () => NOW } };
}
