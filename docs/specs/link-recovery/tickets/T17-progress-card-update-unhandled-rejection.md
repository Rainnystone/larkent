# T17: Catch unhandled rejections when a progress-card update fails

**Status:** ready-for-agent · Source: 2026-10-17 real-Feishu credential-failure test on #47 @ `cc6d435` (isolated bridge rr4, card mode). One implementer session. Blocked by: none (on top of #47 `cc6d435`).

> Replaces the old T17/T18 (loop audit B2/B3: outbox local-failure budget; send failure not link evidence). Those were deleted by user decision 2026-10-17. The same real-Feishu test showed no runaway: an invalid app secret gives HTTP 200 `code 10014`, the outbox retries slowly (~70 s/pass), the agent is not re-run, and delivery recovers once (one reply) after the secret is fixed. Not fixing those.

## Evidence

During the test (app secret made invalid right after the progress card was created), the bridge log had **3× `process:fail kind=unhandledRejection`** with `failed to get tenant_access_token, code: 10014, msg: app secret invalid`. They line up with the three progress-card renders made while the token was failing:

| Time (UTC+8) | Render that triggered the patch |
|---|---|
| 16:23:24 | first producer render after `progress-stream-open` (tool running) |
| 16:24:22 | `tool-done` state update |
| 16:24:26.895 | terminal-state update right after `run:completed` (before the handled `stream:fail step=final-patch` at 16:24:26.906) |

The stack trace only shows node-sdk `TokenManager` frames (the rejection has lost its async origin). The run itself still finished, the final reply went to the outbox and was delivered once after recovery, so the only harm is the unhandled rejections: they go through the process-level `unhandledRejection` handler (`src/cli/commands/start.ts` L74–77 → `log.fail` + `reportError`), the failure is reported as a process error and not a stream warn, and a future Node `--unhandled-rejections=throw` setting would crash the bridge.

## Root cause (verified at `cc6d435`)

The uncaught promise is inside `@larksuite/channel` 0.7.1 (the copy larkent already patches: `patches/@larksuite__channel@0.7.1.patch`). Line numbers below are for the patched `dist/index.mjs` (the `dist/index.cjs` lines are given in brackets):

1. **`Throttle.fireSoon`** (`dist/index.mjs` ~L3841–3847 [cjs ~L3868–3874]; upstream `src/outbound/streaming/throttle.ts`):
   ```js
   this.timer = setTimeout(() => {
     this.timer = void 0;
     this.doFire();          // ← promise dropped: no await, no .catch
   }, delay);
   ```
   `doFire()` awaits `fire()` = `CardStreamControllerImpl.patch()` (~L3972) → `UpdateQueue.enqueue(...)` → `sender.patchCard(...)`. When `patchCard` rejects (here: token fetch throws a plain `Error`), `enqueue`'s returned promise rejects, `doFire()` rejects, and nobody holds that promise → `unhandledRejection`. This is the **only** source of the 3 events.
2. **Why larkent's own `try/catch` doesn't help:** `src/bot/channel.ts` card path (~L1833–1840, and the producer's `await ctrl.update(...)` at ~L1815) wraps `cardCtrl.update(...)` in `try/catch` → `log.fail('stream', …, { step: 'render' })`. But `CardStreamControllerImpl.update()` (~L3944–3948) only stores the card and calls `throttle.note(...)`; it never awaits the patch. So the `catch` can never see a patch failure, and the timer-driven patch is the one that rejects.
3. The terminal path is already handled and must stay as is: `completeTerminal()` → `throttle.flushNow()` awaits its own `doFire()`, so the final patch failure propagates out of `channel.stream(...)` and larkent logs `stream:fail step=final-patch` and falls back to `final-send` / outbox. `UpdateQueue` itself is fine (its `tail` swallows; only the per-call promise rejects).
4. Same bug, same fix, in markdown mode: `MarkdownStreamControllerImpl` uses the same `Throttle` (~L4118, `fire = pushContent()`).

Reproduced in isolation (Throttle + UpdateQueue copied from `dist/index.mjs`, `fire` = enqueue a task that throws, `note(10)`, then `flushNow()`): one `unhandledRejection` from the timer fire, and the `flushNow()` rejection is caught normally.

## Fix (scope)

Extend the existing pnpm patch `patches/@larksuite__channel@0.7.1.patch` (both `dist/index.mjs` and `dist/index.cjs`; regenerate with `pnpm patch` / `pnpm patch-commit`, don't hand-edit hunks):

- `Throttle` gets an optional `onError(err)` (constructor option). The `setTimeout` callback in `fireSoon` becomes `this.doFire().catch((err) => this.onError?.(err))`. Nothing else in `Throttle` changes: `flushNow()` / an awaited `doFire()` still reject to their caller.
- `CardStreamControllerImpl` and `MarkdownStreamControllerImpl` pass an `onError` that logs at **warn** through the sender's logger, e.g. `this.sender.logger?.warn?.("channel: stream intermediate patch failed", { messageId: <last 4 chars>, err: <message> })`. Larkent's SDK logger maps that to `log.warn('sdk', 'warn', …)` (`src/bot/channel.ts` ~L219–226). Log no full IDs and no secrets.
- Nothing else. An intermediate patch failure stays non-fatal (as today); the next render or the terminal flush retries with the latest card.

Do **not** add a process-level swallow, do not change `start.ts`'s `unhandledRejection` handler, and do not wrap `channel.stream` differently.

## Acceptance

- [ ] A failing intermediate progress-card update (timer-driven patch) is caught and logged once per failure at **warn**; no `unhandledRejection` is emitted (card mode and markdown mode).
- [ ] The terminal/final patch failure still rejects out of `channel.stream(...)`: `stream:fail step=final-patch` → `final-send` → outbox behaviour is unchanged. Final reply delivery and outbox staging/resend are unaffected.
- [ ] Unit test (written first, fails on `cc6d435`): drive a real `channel.stream(...)` card stream (or the patched `Throttle` + controller through the package entry) with a fake sender whose `patchCard` rejects; call `ctrl.update(...)`, advance the timer, and assert that no `unhandledRejection` fires (listener on `process`, or vitest's unhandled-error detection) and that the logger got one `warn`. Add a second case where the terminal flush patch rejects and assert `channel.stream` still rejects.
- [ ] Also test the larkent card path: a progress card whose patches fail during the run still ends with the final reply staged/sent exactly as today.
- [ ] No other behaviour change. `pnpm ci:local` passes.

## Out of scope

- Outbox retry budget / link evidence for credential failures (old T17/T18, dropped).
- `patchCard` not checking the body `code` (old T17 V5) and token-failure classification.
