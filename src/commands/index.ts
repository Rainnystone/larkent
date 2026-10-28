import type { UserActionContext } from '../user-actions/context';
import { resolveSlashUserAction } from '../user-actions/registry';
export type { Controls, UserActionContext } from '../user-actions/context';

export function isRegisteredSlashCommand(content: string, options?: { automationsEnabled?: boolean }): boolean {
  const cmd = content.trim().split(/\s+/)[0] ?? '';
  return Boolean(resolveSlashUserAction(cmd)) && (cmd !== '/auto' || options?.automationsEnabled === true);
}

/** Session-switching or stop commands that drop unstarted pending work. */
export function commandClearsPending(content: string): boolean {
  const trimmed = content.trim();
  const [cmd, sub] = trimmed.split(/\s+/);
  switch (cmd) {
    case '/stop':
    case '/new':
    case '/reset':
    case '/cd':
    case '/exit':
      return true;
    case '/resume':
    case '/ws':
      return sub === 'use';
    default:
      return false;
  }
}


export async function tryHandleCommand(ctx: UserActionContext): Promise<boolean> {
  const [cmd = '', ...parts] = ctx.msg.content.trim().split(/\s+/);
  if (!isRegisteredSlashCommand(cmd, { automationsEnabled: ctx.controls.profileConfig.automations.enabled })) return false;
  const action = resolveSlashUserAction(cmd);
  if (!action) return false;
  await action.invoke({ ...ctx, origin: ctx.origin ?? 'slash' }, { command: cmd, args: parts.join(' ') });
  return true;
}
