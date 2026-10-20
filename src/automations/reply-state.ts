import { record, type ToolResult } from '../bridge-tools/protocol';
import { DRAFT_SETTLED_CANCELLED, DRAFT_SETTLED_EXPIRED, DRAFT_SETTLED_SUPERSEDED, draftConfirmedStatus, draftDeletedStatus, draftReplacedStatus } from './draft-card';
import { AUTOMATIONS_DRAFT_TTL_MS, type AutomationDraft } from './store';
import type { AutomationToolContext } from './tools';

/** Only receipts actually returned as waiting in this run can qualify its reply. */
export function trackAutomationReply(context: Pick<AutomationToolContext, 'store' | 'profile' | 'chatId' | 'now'>) {
  const created = new Set<string>();
  const waiting = new Map<string, AutomationDraft>();
  return {
    noteResult(result: ToolResult): void {
      const data = record(result.data);
      if (typeof data?.operationId !== 'string') return;
      try {
        const operation = context.store?.getOperation(data.operationId);
        if (!operation || operation.profile !== context.profile || operation.chatId !== context.chatId) return;
        created.add(operation.operationId);
        if (result.category !== 'waiting-confirmation') return;
        const draft = context.store!.getOperationDraft(operation.draftId);
        if (draft) waiting.set(operation.operationId, draft);
      } catch {
        // Persist is uncertain; throwing here would replace the tool result with tool-failed.
      }
    },
    notice(): string | undefined {
      const lines: string[] = [];
      for (const [operationId, draft] of waiting) {
        const operation = context.store?.getOperation(operationId);
        if (operation?.code === 'draft-superseded') {
          if (!supersededByThisTurn(context, created, operationId)) {
            lines.push(`（回复生成期间已失效：${DRAFT_SETTLED_SUPERSEDED}）`);
          }
          continue;
        }
        if (operation?.state === 'not-applied' && operation.code === 'draft-closed') {
          lines.push(`（回复生成期间已取消：${DRAFT_SETTLED_CANCELLED}）`);
          continue;
        }
        if (operation?.code === 'draft-expired' || (operation?.state === 'received' && draft.createdAt + AUTOMATIONS_DRAFT_TTL_MS <= (context.now ?? Date.now)())) {
          lines.push(`（回复生成期间已失效：${DRAFT_SETTLED_EXPIRED}）`);
          continue;
        }
        if (operation?.state === 'not-applied' && operation.cardStatus) {
          lines.push(`（回复生成期间已失效：${operation.cardStatus}）`);
          continue;
        }
        if (operation?.state !== 'applied' || !operation.taskId) continue;
        const status = draft.op === 'replace' ? draftReplacedStatus(draft.targetId, operation.taskId)
          : draft.op === 'delete' ? draftDeletedStatus(draft.targetId) : draftConfirmedStatus(operation.taskId);
        lines.push(`（回复生成期间已确认：${status}）`);
      }
      return lines.length ? lines.join('\n') : undefined;
    },
  };
}

function supersededByThisTurn(
  context: Pick<AutomationToolContext, 'store'>,
  created: Set<string>,
  operationId: string,
): boolean {
  for (const createdId of created) {
    const createdOp = context.store?.getOperation(createdId);
    const target = createdOp?.supersedesOperationId;
    if (!target) continue;
    if (target === operationId) return true;
    const resolved = context.store?.getOperation(target);
    if (resolved?.operationId === operationId) return true;
  }
  return false;
}
