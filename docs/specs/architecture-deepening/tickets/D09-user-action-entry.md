# D09 One user action entry for commands and card actions

Spec: D2, D11, D13, A7. Blocked by: D06, D07.
Touch: `src/commands/index.ts` (`Controls` ~93-119, `CommandContext` ~121-160, handler map ~167-209, `tryHandleCommand` / `runCommandHandler`), `src/card/dispatcher.ts` (`CardDispatchDeps` ~72-108, if-chain ~124-237, `notice.*` ~331-409, board ~531-569, `makeFakeMsg` ~620-640), `src/bot/channel.ts` (assembly ~1054-1101 and ~1531-1561, `onNoticeAction` ~1083-1099), `src/bot/interactive-card.ts`, tests, `CONTEXT.md`.

## Why

A slash command and a card click are the same thing: a user invoking an action in a scope. Today they have two ~25-field context objects with ~15 overlapping fields, assembled twice in `channel.ts`; the dispatcher rebuilds a `CommandContext` and runs a hard-coded if-chain over five families, each with its own invalid-click UX. Notice-continue re-synthesizes a message in `channel.ts` that duplicates `forwardToAgent`. `makeFakeMsg` hard-codes `chatType: 'p2p'`.

## Do

1. Red: registry tests with a fake event: each action declares `signed(purpose)` or `fence-only`; `config.*`, `account.*`, `ws.*` are `fence-only` (D2); a signed action with a bad token gets that surface's invalid response; access fence denial behaves as today; a card-originated command in a group carries the group's chat type (regression test for D13).
2. Green: one registry and one invocation context built once in `startChannel` (runtime dependencies) plus per-invocation fields (message, scope, chat mode, origin). Slash commands and card actions resolve through it. Automation confirm actions call D07; notice actions use the D06 codec; bridge callbacks and notice-continue share one helper that enqueues a synthetic message.
3. Remove the second context type and the duplicate assembly in `channel.ts`. Collapse the dispatcher to scope resolution, fence, token verify by declared auth, and dispatch.
4. Replace per-file 20-field fixtures with one test helper for the invocation context. Keep green: `tests/integration/bot/*` command and card tests, `tests/unit/card/dispatcher-fence.test.ts` (or its replacement), `notice-dispatch` / `callback-dispatch` tests, `tests/static/contracts.test.ts`, `tests/fixtures/goldens/slash`.
5. Update `CONTEXT.md` (new term: user action). `/code-review`.

## Acceptance

- [ ] Every slash command and card action is registered with a declared auth requirement; no per-family if-chain in `dispatcher.ts`.
- [ ] One invocation context type; `channel.ts` assembles runtime dependencies once.
- [ ] Group card-originated commands carry the real chat type.
- [ ] Tests in Do 4 green; `pnpm ci:local` green; delivery note posted.
