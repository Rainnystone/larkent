import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { automationConfirmBody } from '../../../src/automations/confirm-card';
import { scheduleOccurrenceCount, type Schedule } from '../../../src/automations/schedule';
import { callAutomationTool } from '../../../src/automations/tools';
import { AutomationsStore } from '../../../src/automations/store';

const TZ = 'Asia/Shanghai';
const START = Date.UTC(2026, 9, 18, 16, 0, 0);
const END = Date.UTC(2026, 10, 18, 16, 0, 0);
const AFTER_FIRST_FIRE = Date.UTC(2026, 9, 19, 2, 0, 0);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('uses the card remaining-fire function for preview occurrenceCount after the first fire', async () => {
  const schedule: Schedule = {
    kind: 'daily',
    timezone: TZ,
    times: [{ hour: 9, minute: 0 }],
    startAt: START,
    endAt: END,
  };
  const counted = scheduleOccurrenceCount(schedule, AFTER_FIRST_FIRE);
  expect(counted).toEqual({ count: 30, capped: false });
  expect(automationConfirmBody({
    taskType: 'reminder',
    name: 'Daily regression',
    taskText: 'Synthetic body',
    timezone: TZ,
    schedule,
    now: AFTER_FIRST_FIRE,
  }).split('\n\n')).toContain('共 30 次');

  const preview = await callAutomationTool('automation.preview', {
    taskType: 'reminder',
    schedule: { kind: 'daily', timezone: TZ, times: [{ hour: 9, minute: 0 }], startAt: START, endAt: END },
  }, await toolContext(AFTER_FIRST_FIRE));
  expect(preview).toMatchObject({
    category: 'ok',
    data: { occurrenceCount: 30, totalCount: 30 },
  });
  expect((preview.data as { occurrenceCount: number }).occurrenceCount).toBe(counted.count);
});


it('tells the model to cite occurrenceCount and paraphrase status codes', async () => {
  const skill = await readFile(join(process.cwd(), 'plugins/automation/skills/automations/SKILL.md'), 'utf8');
  expect(skill).toContain('occurrenceCount');
  expect(skill).toContain('还需选择结束日期');
  expect(skill).toContain('等待在卡上确认');
  expect(skill).toMatch(/needs-input[\s\S]{0,80}还需选择结束日期|还需选择结束日期[\s\S]{0,80}needs-input/);
  expect(skill).toMatch(/waiting-confirmation[\s\S]{0,80}等待在卡上确认|等待在卡上确认[\s\S]{0,80}waiting-confirmation/);
});

async function toolContext(now: number) {
  const dir = await mkdtemp(join(tmpdir(), 'occurrence-count-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => now,
  });
  await store.load();
  return {
    profile: 'synthetic',
    chatId: 'oc_synthetic',
    actorId: 'ou_synthetic',
    runType: 'im' as const,
    availability: () => undefined,
    store,
    timezone: TZ,
    agentTasks: false,
    now: () => now,
  };
}
