import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ResumeHistoryEntry, ResumeHistoryInput } from '../definition';
import { log } from '../../core/logger';

const execFileAsync = promisify(execFile);

interface DevinListSession {
  id?: unknown;
  short_id?: unknown;
  working_directory?: unknown;
  last_activity_at?: unknown;
  title?: unknown;
}

/**
 * `devin list --format json` prints the CLI's own sessions for the current
 * directory, so the bridge's /resume picker can offer real Devin sessions
 * instead of only bridge-tracked handles.
 */
export async function listDevinResumeHistory(
  input: ResumeHistoryInput,
): Promise<ResumeHistoryEntry[]> {
  const binary = input.profile.agent.binaryPath ?? 'devin';
  let cwdReal: string;
  try {
    cwdReal = await realpath(input.cwd);
  } catch {
    return [];
  }
  let sessions: DevinListSession[];
  try {
    const { stdout } = await execFileAsync(binary, ['list', '--format', 'json'], {
      cwd: input.cwd,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    sessions = parsed as DevinListSession[];
  } catch (err) {
    log.warn('session', 'devin-history-failed', {
      profile: input.profileDir,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const entries: ResumeHistoryEntry[] = [];
  for (const session of sessions) {
    const dir = typeof session.working_directory === 'string' ? session.working_directory : '';
    if (!dir) continue;
    let matches = false;
    try {
      matches = (await realpath(dir)) === cwdReal;
    } catch {
      matches = dir === input.cwd;
    }
    if (!matches) continue;
    const id =
      typeof session.id === 'string' && session.id
        ? session.id
        : typeof session.short_id === 'string'
          ? session.short_id
          : '';
    if (!id) continue;
    entries.push({
      resumeHandle: id,
      preview: typeof session.title === 'string' ? session.title : '',
      updatedAtMs:
        typeof session.last_activity_at === 'number' ? session.last_activity_at * 1000 : 0,
      detail: 'Devin',
    });
  }
  entries.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return entries.slice(0, input.limit);
}
