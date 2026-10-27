# D06 One action token codec

Spec: D10, D1, A6. Blocked by: none.
Touch: `src/card/callback-auth.ts`, `src/bot/interruption-notice.ts` (`NoticeActionAuth`, ~108-226), `src/automations/action-auth.ts`, `src/automations/board-auth.ts`, `src/card/callback-store.ts`, construction in `src/bot/channel.ts` (~406-425), verify call sites in `src/card/dispatcher.ts`, new codec module (e.g. `src/card/action-token.ts`), tests, `CONTEXT.md`.

## Why

Four classes hand-write `PREFIX.payload.hmac` split / decode / expiry / `timingSafeEqual` with prefixes `bridge_cb.v1`, `notice_cb.v1`, `auto_cb.v1`, `auto_board.v1`. Nonce rules diverged: consume on verify, deferred claim / release / consume (driving the dance in `dispatcher.ts:458-498`), and none. `src/bridge-tools/server.ts`, `src/ui/http.ts` and `src/automations/status-push.ts` also use HMAC for other purposes; they are out of scope unless they sign card actions.

## Do

1. Red: codec tests: round trip per purpose; wrong purpose; tampered payload or signature; expired; key rotation (current and previous key verify, new tokens use current); nonce policy `none` / `consume-on-verify` (replay rejected) / `deferred` (verify does not consume; claim, release, consume explicit; concurrent claim loses); context binding (scope, turn, policy fingerprint where the purpose binds them).
2. Green: implement the codec; reduce the four classes to claims schemas plus a purpose / policy declaration, or delete them where a plain codec call suffices.
3. Wire format may change (D1). Keep invalid-click responses unchanged for tokens issued before the deploy.
4. Keep green: `tests/unit/card/callback-auth*.test.ts`, notice, auto action and board auth tests (consolidate into the codec suite where they only test crypto), `tests/integration/bot/interruption-notice.test.ts`, `auto-board-card.test.ts`, dispatcher tests.
5. Update `CONTEXT.md` (new term: action token). `/code-review`.

## Acceptance

- [ ] No card-action module other than the codec calls `createHmac` / `timingSafeEqual`.
- [ ] Each purpose declares its nonce policy in one place.
- [ ] Tests in Do 4 green; `pnpm ci:local` green; delivery note posted.
