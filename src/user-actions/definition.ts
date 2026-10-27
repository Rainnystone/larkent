import type { CardActionResponse } from '@larksuite/channel';
import type { UserActionContext } from './context';

export type UserActionAuth =
  | { kind: 'fence-only' }
  | { kind: 'signed'; purpose: 'bridge-callback' | 'interruption-notice' | 'automation-confirm' | 'automation-board' };
export type ActionPayload = Record<string, unknown>;
export type ActionResponse = CardActionResponse | void;
export type ActionHandler = (ctx: UserActionContext, payload: ActionPayload) => Promise<ActionResponse>;

export interface UserAction {
  auth: UserActionAuth;
  invoke: ActionHandler;
}

/** Signing policy and verification are declared together, never inferred by omission. */
export function signedAction<Claims>(
  purpose: Extract<UserActionAuth, { kind: 'signed' }>['purpose'],
  verify: (ctx: UserActionContext, payload: ActionPayload) => Claims | undefined | Promise<Claims | undefined>,
  handle: (ctx: UserActionContext, payload: ActionPayload, claims: Claims) => Promise<ActionResponse>,
  invalid: ActionHandler,
): UserAction {
  return {
    auth: { kind: 'signed', purpose },
    async invoke(ctx, payload) {
      const claims = await verify(ctx, payload);
      return claims === undefined ? invalid(ctx, payload) : handle(ctx, payload, claims);
    },
  };
}

export function fenceOnlyAction(invoke: ActionHandler): UserAction {
  return { auth: { kind: 'fence-only' }, invoke };
}
