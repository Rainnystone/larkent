import type { ResumeHistoryEntry, ResumeHistoryInput } from '../definition';
import { listCodexThreadHistory } from '../../session/codex-history';
import { codexThreadHistoryEnv } from './options';
import { log } from '../../core/logger';

export async function listCodexResumeHistory(input: ResumeHistoryInput): Promise<ResumeHistoryEntry[]> {
  const binary = input.profile.agent.binaryPath ?? input.profile.codex?.binaryPath;
  if (!binary) return [];
  try {
    const threads = await listCodexThreadHistory({
      binary,
      cwd: input.cwd,
      limit: input.limit,
      profileStateDir: input.profileDir,
      ...codexThreadHistoryEnv(input.profile),
    });
    return threads.map(thread => ({
      resumeHandle: thread.threadId,
      preview: thread.name || thread.preview,
      updatedAtMs: thread.updatedAtMs,
      detail: `Codex · ${thread.source}`,
    }));
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      profile: input.profileDir,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
