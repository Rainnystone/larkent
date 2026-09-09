import type { ResumeHistoryEntry, ResumeHistoryInput } from '../definition';
import { listRecentSessions } from '../../session/history';

export async function listClaudeResumeHistory(input: ResumeHistoryInput): Promise<ResumeHistoryEntry[]> {
  const sessions = await listRecentSessions(input.cwd, input.limit);
  return sessions.map(session => ({
    resumeHandle: session.sessionId,
    preview: session.preview,
    updatedAtMs: session.mtime,
    lineCount: session.lineCount,
  }));
}
