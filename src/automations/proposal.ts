import type { RunState } from '../card/run-state';
import type { AutomationTaskType } from './store';

export const AUTOMATION_PROPOSAL_OPEN = '<automation_proposal>';
export const AUTOMATION_PROPOSAL_CLOSE = '</automation_proposal>';

export interface AutomationProposalFields {
  taskType: AutomationTaskType;
  scheduleText: string;
  name: string;
  taskText: string;
}

export const AUTOMATION_PROPOSAL_INSTRUCTION = [
  '当用户要用自然语言在本群创建定时提醒或 agent 任务时，在最终回复末尾附加一个 <automation_proposal> JSON 块。',
  '块内仅一段 JSON：{"taskType":"reminder 或 agent","schedule":"<时间表>","name":"<短名称>","taskText":"<任务原文>"}。',
  '时间表用与 /auto new 相同的语法（如 10 分钟后、2026-10-18 15:50、今天 15:50、明天 09:00、每个工作日 09:00、every 30m 09:00-18:00 until 2026-12-31、从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05）。',
  '一次性绝对时刻用 YYYY-MM-DD HH:MM 或 今天/明天/后天 HH:MM；周期任务从某天开始时用「从 <日期> [HH:MM] 起」前缀。',
  '相对时间由 bridge 换成绝对时刻。',
  '不要把该块当作给用户看的正文。群、scope、创建者由 bridge 从当前对话取；提案里即使写了 chatId/scope/createdBy 也会被忽略。',
  '仅在当前消息来自人类、且不是 auto: 或 meeting: 自动化 run 时产出提案。默认 taskType 为 reminder。',
].join('');

function proposalBlockRe(): RegExp {
  return new RegExp(
    `${AUTOMATION_PROPOSAL_OPEN}\\s*([\\s\\S]*?)\\s*${AUTOMATION_PROPOSAL_CLOSE}`,
    'gi',
  );
}

export interface ExtractedAutomationProposal {
  visible: string;
  tagged: boolean;
  parsed?: AutomationProposalFields;
}

export function extractAutomationProposal(text: string): ExtractedAutomationProposal {
  const parsed = parseLastProposal(text);
  const tagged = hasProposalTag(text);
  return {
    visible: tagged ? stripProposalTags(text) : text,
    tagged,
    ...(parsed ? { parsed } : {}),
  };
}

/** Text the bridge inspects for a proposal: visible text blocks plus held-back `finalText`. */
export function proposalTextFromState(state: RunState): string {
  const parts: string[] = [];
  for (const block of state.blocks) {
    switch (block.kind) {
      case 'text':
        if (block.content) parts.push(block.content);
        break;
      case 'tool':
        break;
      default: {
        const _exhaustive: never = block;
        throw _exhaustive;
      }
    }
  }
  if (state.finalText) parts.push(state.finalText);
  return parts.join('\n');
}

export function stripProposalFromState(state: RunState): RunState {
  return {
    ...state,
    ...(state.finalText !== undefined ? { finalText: stripProposalTags(state.finalText) } : {}),
    blocks: state.blocks.map((block) => {
      switch (block.kind) {
        case 'text':
          return { ...block, content: stripProposalTags(block.content) };
        case 'tool':
          return block;
        default: {
          const _exhaustive: never = block;
          return _exhaustive;
        }
      }
    }),
  };
}

export function parseAutomationProposalJson(raw: string): AutomationProposalFields | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const schedule = typeof rec.schedule === 'string' ? rec.schedule.trim() : '';
  const taskText = typeof rec.taskText === 'string' ? rec.taskText.trim() : '';
  if (!schedule || !taskText) return undefined;
  const nameRaw = typeof rec.name === 'string' ? rec.name.trim() : '';
  return {
    taskType: rec.taskType === 'agent' ? 'agent' : 'reminder',
    scheduleText: schedule,
    name: nameRaw || taskText,
    taskText,
  };
}

export function shouldHonorAutomationProposal(input: {
  enabled: boolean;
  scope: string;
  senderId: string;
  senderType?: string;
  botOpenId?: string;
}): boolean {
  if (!input.enabled) return false;
  if (input.scope.startsWith('auto:') || input.scope.startsWith('meeting:')) return false;
  if (input.senderType === 'app' || input.senderType === 'bot') return false;
  if (input.botOpenId && input.senderId === input.botOpenId) return false;
  return true;
}

function hasProposalTag(text: string): boolean {
  return /<automation_proposal>/i.test(text);
}

function parseLastProposal(text: string): AutomationProposalFields | undefined {
  const matches = [...text.matchAll(proposalBlockRe())];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const parsed = parseAutomationProposalJson(matches[i]?.[1] ?? '');
    if (parsed) return parsed;
  }
  return undefined;
}

function lastOpenTagIndex(text: string): number {
  let openAt = -1;
  for (const match of text.matchAll(/<automation_proposal>/gi)) {
    if (match.index !== undefined) openAt = match.index;
  }
  return openAt;
}

function stripProposalTags(text: string): string {
  let out = text.replace(proposalBlockRe(), '');
  const openAt = lastOpenTagIndex(out);
  if (openAt >= 0 && !new RegExp(AUTOMATION_PROPOSAL_CLOSE, 'i').test(out.slice(openAt))) {
    out = out.slice(0, openAt);
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
