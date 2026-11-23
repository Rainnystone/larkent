# 01 — Tenant token self-heal on rawClient (tracer)

Blocked by: none.
Spec: `README.md` D1–D7, D10, Testing.

## What
Add `src/bot/feishu-token-retry.ts` and install it per channel in `startChannel`. On `99991663`/`99991661` from a call using the bridge's tenant token: evict that app's cached token (real delete, never `set(...,0)`), refresh once via singleflight + generation, replay the request once.

Start by reading the installed `@larksuiteoapi/node-sdk` source to confirm the hook point (D3) and the cache key/API (D4). Put both findings in your `done 01` comment on the docs PR (you do not push to the docs branch).

## Acceptance (each is a test)
1. Cached token rejected with HTTP 400 `{code: 99991663}` → exactly one auth POST, one replay, call succeeds. Covers at least `rawClient.request`, one `im.v1.message` call, and the path `getAppInfo` uses.
2. Same for `400 {code: 99991661}` and for a resolved `200 {code: 99991663}` body.
3. 8 concurrent calls rejected with the old token, plus one late rejection arriving after the refresh → exactly one auth POST; the new token is not evicted; all 9 succeed.
4. Server keeps rejecting (or auth endpoint fails) → each call replays at most once, then throws the original error; within the next 10 s no further forced refresh; `auth.token-refresh-failed` logged; no token text in any log line.
5. After eviction the SDK cache returns no token for that key (guards the `expiredTime: 0` trap).
6. Two channels with different appIds in one process: a rejection on one never evicts or refreshes the other.
7. A call carrying its own `Authorization` header and codes outside D2 (`99991664`, `99991672`, `230002`, 5xx) are not replayed.
8. `pnpm ci:local` green.
