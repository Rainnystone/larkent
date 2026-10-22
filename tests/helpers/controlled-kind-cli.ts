import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installKindCli, jsonlScript, type JsonlScript, type PinAgentKind } from './scripted-jsonl-cli.js';

export interface ControlledKindCli {
  path: string;
  recordPath: string;
  readyPath: string;
  answer: string;
  resumeHandle: string;
  release(): Promise<void>;
  setScript(script: JsonlScript): Promise<void>;
  waitReady(): Promise<void>;
}

export async function installControlledKindCli(root: string, kind: PinAgentKind, label: 'A' | 'B'): Promise<ControlledKindCli> {
  const dir = await mkdtemp(join(root, `controlled-${kind}-${label}-`));
  const { fake } = await installKindCli(dir, kind);
  const readyPath = join(dir, 'ready');
  const releasePath = join(dir, 'release');
  const recordPath = join(dir, 'calls.jsonl');
  const answer = `ANSWER_${label}`;
  const resumeHandle = kind === 'codex' ? `thread-${label}` : kind === 'kimi' ? `session_${label}` :
    label === 'A' ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const controlled: ControlledKindCli = {
    path: fake.path, recordPath, readyPath, answer, resumeHandle,
    async release() {
      await writeFile(`${releasePath}.tmp`, 'release');
      await rename(`${releasePath}.tmp`, releasePath);
    },
    async setScript(script) {
      // Preserve dialects, replacing only fixture identity and optional stale cwd.
      const mapIdentity = (text: string) => text
        .replaceAll('PINNED_ANSWER', answer)
        .replaceAll('thread-pin-codex', resumeHandle)
        .replaceAll('session_pin_kimi', resumeHandle)
        .replaceAll('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', resumeHandle)
        .replaceAll('c6b62c6f-7ead-4fd6-9922-e952131177ff', resumeHandle);
      const lines = script.lines.map(line => {
        const mapped = typeof line === 'string' ? mapIdentity(line) : JSON.parse(mapIdentity(JSON.stringify(line)));
        if (mapped && typeof mapped === 'object' && mapped.cwd === '/tmp') delete mapped.cwd;
        return mapped;
      });
      const exportSessionId = script.exportSessionId ? mapIdentity(script.exportSessionId) : undefined;
      await rm(readyPath, { force: true });
      await rm(releasePath, { force: true });
      await writeFile(fake.scriptPath, JSON.stringify({
        ...script, lines, ...(exportSessionId ? { exportSessionId } : {}), readyPath, releasePath, recordAppendPath: recordPath,
        ...(kind === 'codex' ? { codexStateRoot: root } : {}),
      }));
    },
    async waitReady() {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          await access(readyPath);
          const pid = Number(await readFile(readyPath, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(10);
      }
      throw new Error(`test ready gate timed out: ${kind} ${label}`);
    },
  };
  await controlled.setScript(jsonlScript(kind, 'success'));
  return controlled;
}
