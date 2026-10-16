# T11: One error classifier; stream outside the outbound timeout

**Status:** ready-for-agent · Audit: D2 + D1 (F1, F6, F7, F8, F10)

## Goal

Stop fake outages and the rejection/recovery loop, which make every other failure worse.
- `stream` is no longer wrapped in the 30 s outbound timeout. The SDK's `httpTimeoutMs` already bounds each REST call (invariant I7).
- One classifier `src/bot/feishu-error.ts`: `classify(err) → 'link' | 'rejected' | 'local'`, a closed set switched exhaustively (I4, I5). It walks `err → .cause → .cause`, then applies these rules in order:
  - `OutboundTimeoutError` → link
  - HTTP ≥ 500, 408 or 429 → link
  - any other 4xx → rejected
  - `LarkChannelError.code` `format_error` / `target_revoked` / `permission_denied` / `ssrf_blocked` → rejected; `send_timeout` → link
  - axios error with `request` but no `response`, or a network errno → link
  - anything else → local
- FeishuLink and delivery both use it. FeishuLink calls `goDown` only on `link`.
- SDK-faithful error doubles: test helpers that build `LarkChannelError` with the axios error as `cause` (as the real `@larksuite/channel` does), including 400, 403, 429, 502, ENETUNREACH, EHOSTUNREACH and a TLS disconnect (I10).

## Spec sections

Delivery invariants (I4, I5, I7, I10); §2 FeishuLink "Down on"; §6

## Acceptance (behaviour, failing first)

- [ ] Table-driven classifier test over errors produced by the real SDK (stub `sender.client`): each case maps to the expected class. It covers 400/403 → rejected; 429/502-wrapped/ENETUNREACH/EHOSTUNREACH/TLS/timeout → link; a plain bug → local.
- [ ] A 5-minute streamed run (fake timers) causes no outage and no recovery, `outageOverlapped=false`, and a tool-call run in another chat is not stopped.
- [ ] A staged reply rejected with 403: the link stays up, there is no recovery loop, and the chat sees exactly one fallback outcome.
- [ ] ENETUNREACH on a final send: no immediate retry; delivered once after recovery.
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/feishu-error.ts` (new), `src/bot/feishu-link.ts`, `src/bot/self-message.ts`, `src/bot/channel.ts` (delivery error branches), test helpers for SDK-shaped errors, `feishu-link` / delivery tests

## Delete

`isBusiness4xx`, `isLinkFailureError`, `LINK_ERRNO` (including the ECONNABORTED addition), the `LINK_MESSAGE` regex; `stream` from the timed outbound operations.

## Blocked by

T10 (code track at review head)
