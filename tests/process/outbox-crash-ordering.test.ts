import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { Outbox } from '../../src/bot/outbox';
import { TurnJournal } from '../../src/bot/turn-journal';
import {
  crashRecordingChannel,
  remoteMessages,
} from '../helpers/outbox-crash-channel';

const timeout = process.platform === 'win32' ? 30_000 : 15_000;
describe('Outbox crash ordering', () => {
  it.each(['stage', 'receipt', 'recall'])(
    'recovers exactly one visible answer after kill between %s operations',
    async (phase) => {
      const dir = await mkdtemp(join(tmpdir(), 'outbox-kill-'));
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('../helpers/outbox-crash-worker.ts', import.meta.url),
          ),
          dir,
          phase,
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      let output = '';
      child.stdout?.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        output += chunk;
      });
      const exited = once(child, 'exit');
      try {
        const paused = await Promise.race([
          once(child, 'message').then(([message]) => message === 'paused'),
          exited.then(() => {
            throw new Error(
              `fixture exited before crash checkpoint: ${output}`,
            );
          }),
        ]);
        expect(paused).toBe(true);
        child.kill('SIGKILL');
        await exited;
        const journal = new TurnJournal(join(dir, 'turn-journal.json'));
        await journal.load();
        const channel = crashRecordingChannel(join(dir, 'remote.json'));
        const outbox = new Outbox({
          channel: channel as unknown as LarkChannel,
          journal,
          botAppId: 'cli_bot',
        });
        await outbox.redeliver();
        await outbox.redeliver();
        expect(
          (await remoteMessages(join(dir, 'remote.json')))
            .filter((message) => !message.recalled)
            .map((message) => message.content),
        ).toEqual([{ markdown: 'answer' }]);
        expect(journal.get('crash-turn')?.reply?.state).toBe('sent');
        outbox.stop();
        await journal.flush();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    timeout,
  );
});
