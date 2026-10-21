import type { RunState } from './run-state';

// Display-only filtering for resumed transcripts. Legacy text never becomes a request.
function proposalBlockRe(): RegExp {
  return /<automation_proposal>\s*[\s\S]*?\s*<\/automation_proposal>/gi;
}

export function stripLegacyAutomationTagsFromState(state: RunState): RunState {
  return {
    ...state,
    ...(state.finalText !== undefined ? { finalText: stripLegacyAutomationTags(state.finalText) } : {}),
    blocks: state.blocks.map((block) => {
      switch (block.kind) {
        case 'text':
          return { ...block, content: stripLegacyAutomationTags(block.content) };
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

function lastOpenTagIndex(text: string): number {
  let openAt = -1;
  for (const match of text.matchAll(/<automation_proposal>/gi)) {
    if (match.index !== undefined) openAt = match.index;
  }
  return openAt;
}

function stripLegacyAutomationTags(text: string): string {
  if (!/<automation_proposal>/i.test(text)) return text;
  let out = text.replace(proposalBlockRe(), '');
  const openAt = lastOpenTagIndex(out);
  if (openAt >= 0 && !/<\/automation_proposal>/i.test(out.slice(openAt))) {
    out = out.slice(0, openAt);
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
