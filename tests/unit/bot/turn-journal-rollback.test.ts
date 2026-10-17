import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('master loaders ignore a sibling turn-journal.json', () => {
  it('does not rewrite the journal file when sessions, workspaces, or the ledger load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journal-rollback-'));
    dirs.push(dir);
    const journalBytes = `${JSON.stringify({
      schemaVersion: 1,
      entries: [{
        turnId: 'turn-keep',
        scope: 'oc_group',
        chatId: 'oc_group',
        messageIds: ['om_1'],
        senderId: 'ou_user',
        initiatorId: 'ou_user',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      }],
    }, null, 2)}\n`;
    const journalFile = join(dir, 'turn-journal.json');
    await writeFile(journalFile, journalBytes);
    await writeFile(join(dir, 'sessions.json'), '{"schemaVersion":2,"entries":{}}\n');
    await writeFile(join(dir, 'workspaces.json'), '{"schemaVersion":2,"chats":{},"named":{}}\n');
    await writeFile(join(dir, 'backfill-state.json'), '{"schemaVersion":1,"processed":{}}\n');

    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
    const ledger = new BackfillLedger(join(dir, 'backfill-state.json'));
    await sessions.load();
    await workspaces.load();
    await ledger.load();
    sessions.set('oc_group', 'sess', '/tmp');
    workspaces.setCwd('oc_group', '/tmp');
    ledger.record('om_other', 2);
    await sessions.flush();
    await workspaces.flush();
    await ledger.flush();

    expect(await readFile(journalFile, 'utf8')).toBe(journalBytes);
  });

  it('keeps journal loading out of sessions, workspaces, and ledger sources', () => {
    const sources = [
      readFileSync(new URL('../../../src/session/store.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../src/workspace/store.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../src/bot/backfill-ledger.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/turn-journal/);
  });
});

describe('existing stores ignore a sibling automations.json', () => {
  it('does not rewrite automations files when sessions, workspaces, ledger, or journal load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'automations-rollback-'));
    dirs.push(dir);
    const automationsBytes = `${JSON.stringify({
      schemaVersion: 1,
      nextId: 2,
      items: [],
      drafts: [],
      started: [],
    }, null, 2)}\n`;
    const automationsFile = join(dir, 'automations.json');
    const logFile = join(dir, 'automations.log');
    await writeFile(automationsFile, automationsBytes);
    await writeFile(logFile, '[]\n');
    await writeFile(join(dir, 'sessions.json'), '{"schemaVersion":2,"entries":{}}\n');
    await writeFile(join(dir, 'workspaces.json'), '{"schemaVersion":2,"chats":{},"named":{}}\n');
    await writeFile(join(dir, 'backfill-state.json'), '{"schemaVersion":1,"processed":{}}\n');
    await writeFile(join(dir, 'turn-journal.json'), '{"schemaVersion":1,"entries":[]}\n');

    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
    const ledger = new BackfillLedger(join(dir, 'backfill-state.json'));
    const journal = new TurnJournal(join(dir, 'turn-journal.json'));
    await sessions.load();
    await workspaces.load();
    await ledger.load();
    await journal.load();
    sessions.set('oc_group', 'sess', '/tmp');
    workspaces.setCwd('oc_group', '/tmp');
    ledger.record('om_other', 2);
    await sessions.flush();
    await workspaces.flush();
    await ledger.flush();
    await journal.flush();

    expect(await readFile(automationsFile, 'utf8')).toBe(automationsBytes);
    expect(await readFile(logFile, 'utf8')).toBe('[]\n');
  });
});
