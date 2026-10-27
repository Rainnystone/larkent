import * as commands from '../commands/handlers';
import { handleAutoCommand } from '../automations/command';
import { AUTO_CARD_ACTIONS } from '../automations/action-auth';
import { canRunAdminCommand } from '../policy/access';
import { log, reportMetric } from '../core/logger';
import { fenceOnlyAction, signedAction, type ActionPayload, type UserAction } from './definition';
import type { UserActionContext } from './context';
import {
  automationInvalid, BRIDGE_CALLBACK_MARKER, forwardBridgeAction, handleAutomationAction,
  handleBoardAction, handleNoticeAction, LEGACY_CALLBACK_MARKER, sendNoticeInvalid,
  verifyBoardAction, verifyBridgeAction, verifyDraftAction, verifyNoticeAction,
} from './card-actions';

type CommandHandler = (args: string, ctx: UserActionContext) => Promise<void>;

function command(handler: CommandHandler, admin = false): UserAction {
  return fenceOnlyAction(async (ctx, payload) => {
    const name = String(payload.command ?? '');
    const invocation = ctx.resolveSessionCatalogIdentity
      ? { ...ctx, sessionCatalogIdentity: await ctx.resolveSessionCatalogIdentity() } : ctx;
    if (admin && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
      log.info('command', 'admin-deny', { cmd: name, sender: ctx.msg.senderId.slice(-6), ...(ctx.origin === 'card' ? { via: 'card' } : {}) });
      if (ctx.origin !== 'card') await commands.reply(ctx, '❌ 此命令仅管理员可用。');
      return;
    }
    try {
      await handler(typeof payload.args === 'string' ? payload.args : '', invocation);
    } catch (error) {
      log.fail('command', error, { cmd: name });
      reportMetric('command_fail', 1, { step: ctx.origin === 'card' ? 'handler' : 'dispatch' });
    }
  });
}

const ignoreInvalid = async () => {};
const notice = signedAction('interruption-notice', verifyNoticeAction, handleNoticeAction, sendNoticeInvalid);
const draft = signedAction('automation-confirm', verifyDraftAction, handleAutomationAction, automationInvalid);
const board = signedAction('automation-board', verifyBoardAction, handleBoardAction, automationInvalid);
const callback = signedAction('bridge-callback', verifyBridgeAction, forwardBridgeAction, ignoreInvalid);

/** The only registration source for slash commands and card actions. Command
 * families accept their existing dot-separated subcommands under the same policy. */
export const USER_ACTIONS: Readonly<Record<string, UserAction>> = {
  '/new': command(commands.handleNew),
  '/reset': command(commands.handleNew),
  '/cd': command(commands.handleCd, true),
  '/ws': command(commands.handleWs, true),
  '/resume': command(commands.handleResume),
  '/status': command(commands.handleStatus),
  '/help': command(commands.handleHelp),
  '/account': command(commands.handleAccount, true),
  '/config': command(commands.handleConfig, true),
  '/stop': command(commands.handleStop),
  '/timeout': command(commands.handleTimeout),
  '/ps': command(commands.handlePs, true),
  '/exit': command(commands.handleExit, true),
  '/doctor': command(commands.handleDoctor, true),
  '/reconnect': command(commands.handleReconnect, true),
  '/doc': command(commands.handleDoc),
  '/invite': command(commands.handleInvite, true),
  '/remove': command(commands.handleRemove, true),
  '/meeting': command(commands.handleMeeting, true),
  '/auto': command(handleAutoCommand),
  'notice.continue': notice,
  'notice.dismiss': notice,
  ...Object.fromEntries(AUTO_CARD_ACTIONS.map(action => [action, draft])),
  'auto.pause': board,
  'auto.resume': board,
  'auto.delete': board,
  'agent_callback': callback,
};

export function resolveSlashUserAction(name: string): UserAction | undefined {
  return name.startsWith('/') && Object.hasOwn(USER_ACTIONS, name) ? USER_ACTIONS[name] : undefined;
}

export function resolveCardUserAction(payload: ActionPayload): UserAction | undefined {
  if (LEGACY_CALLBACK_MARKER in payload) return;
  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd && cmd !== 'agent_callback' && Object.hasOwn(USER_ACTIONS, cmd) && !cmd.startsWith('/')) return USER_ACTIONS[cmd];
  if (!cmd) return BRIDGE_CALLBACK_MARKER in payload ? USER_ACTIONS.agent_callback : undefined;
  const [name, ...rest] = cmd.split('.');
  const action = resolveSlashUserAction(`/${name}`);
  if (!action) return;
  const sub = rest.join(' ');
  const arg = (typeof payload.arg === 'string' && payload.arg) || (typeof payload.name === 'string' && payload.name) || '';
  const invoke = async (ctx: UserActionContext) => action.invoke(ctx, {
    command: name, args: sub && arg ? `${sub} ${arg}` : sub,
  });
  // A bridge-signed command retains its stronger binding even when the same
  // command also has a deliberately unsigned, fence-only button.
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string'
    ? signedAction('bridge-callback', verifyBridgeAction, invoke, ignoreInvalid)
    : fenceOnlyAction(invoke);
}
