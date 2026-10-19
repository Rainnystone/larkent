import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AutomationsStore } from '../../../src/automations/store';
import {
  automationSchema,
  callAutomationTool,
  type AutomationToolContext,
} from '../../../src/automations/tools';

const NOW = 1_760_000_000_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('returns lastStatus never from automation.list for a newly created task', async () => {
  const { context } = await toolContext();
  await context.store!.create({
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW + 600_000,
    endAt: NOW + 600_000,
    nextFireAt: NOW + 600_000,
    chatId: context.chatId,
    createdBy: context.actorId,
    name: '交周报',
    taskText: '提醒交周报',
  });
  expect(await callAutomationTool('automation.list', {}, context)).toMatchObject({
    category: 'ok',
    code: 'tasks',
    data: { tasks: [expect.objectContaining({ id: 1, name: '交周报', lastStatus: 'never' })] },
  });
});

it('returns lastStatus never from automation.list for lastFireAt 0 and lastStatus ok on disk', async () => {
  const { context, dir } = await toolContext();
  const path = join(dir, 'automations.json');
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 2,
    nextId: 2,
    items: [{
      id: 1,
      taskType: 'reminder',
      schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
      timezone: 'Asia/Shanghai',
      startAt: NOW + 600_000,
      endAt: NOW + 600_000,
      nextFireAt: NOW + 600_000,
      lastFireAt: 0,
      paused: false,
      missed: 0,
      lastStatus: 'ok',
      fireHistory: [],
      chatId: context.chatId,
      createdBy: context.actorId,
      name: '交周报',
      taskText: '提醒交周报',
      missedInstants: [],
      skippedInstants: [],
    }],
    drafts: [],
    started: [],
    boards: [],
    operations: [],
  })}\n`);
  const reloaded = new AutomationsStore({
    path,
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW,
  });
  await reloaded.load();
  expect(await callAutomationTool('automation.list', {}, { ...context, store: reloaded })).toMatchObject({
    category: 'ok',
    data: { tasks: [expect.objectContaining({ id: 1, name: '交周报', lastStatus: 'never' })] },
  });
});

it('documents lastStatus never in automation.schema', () => {
  const schema = automationSchema({
    profile: 'synthetic',
    chatId: 'oc_synthetic',
    actorId: 'ou_synthetic',
    runType: 'im',
    availability: () => undefined,
    timezone: 'Asia/Shanghai',
    agentTasks: false,
  });
  expect(schema.lastStatus).toEqual({
    never: 'not-yet-fired',
    running: 'in-flight',
    ok: 'last-run-succeeded',
    failed: 'last-run-failed',
    missed: 'last-fire-missed',
  });
});

it('tells the model to say 尚未运行 when lastStatus is never', async () => {
  const skill = await readFile(
    join(process.cwd(), 'plugins/automation/skills/automations/SKILL.md'),
    'utf8',
  );
  expect(skill).toContain('lastStatus');
  expect(skill).toContain('never');
  expect(skill).toContain('尚未运行');
  expect(skill).toMatch(/never[\s\S]{0,80}尚未运行|尚未运行[\s\S]{0,80}never/);
});

async function toolContext(): Promise<{ context: AutomationToolContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'last-status-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW,
  });
  await store.load();
  return {
    dir,
    context: {
      profile: 'synthetic',
      chatId: 'oc_synthetic',
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
