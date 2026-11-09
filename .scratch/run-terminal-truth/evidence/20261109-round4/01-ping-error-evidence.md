# SEED + PING(+PONG) evidence

## Conversation map
- **conversationId (all):** `6b9dd5db-bd08-4f29-adb6-a0380b7f563f`
- SEED run `543fe89d-…` → terminal-result SUCCESS numTurns=1 (new session)
- PING run `10a55686-…` → `session/resume` resumeHandle=same cid → terminal-result **ERROR** numTurns=2
- PONG (already in log @09:51) → `session/resume` same cid → terminal-result **ERROR** numTurns=3 (exit code 0)

## Captures
| turn | path |
|------|------|
| SEED | `~/.lark-channel-e2e/rt1/stdout-captures/stdout-agy-543fe89d-dd44-4574-9e7a-c659731e5122.jsonl` |
| PING | `~/.lark-channel-e2e/rt1/stdout-captures/stdout-agy-10a55686-e56d-463c-9d8e-934d73ff4569.jsonl` |
| PONG | `~/.lark-channel-e2e/rt1/stdout-captures/stdout-agy-288d45af-02ca-4e2d-b223-4d1184d68927.jsonl` |

## PING raw error (stdout result + terminal-result)
`failed to construct executor: unknown model key MODEL_PLACEHOLDER_M418: model not found`

Also stderr: `timeout waiting for cascade to start running`.

**Not** logged as `Bad Gateway` / `daily-cloudcode-pa.googleapis.com`. Do **not** label this capture as proven model-host CONNECT upstream error without that string.

## numTurns
Only turn index (1→2→3). Attribution = this runId’s result/terminal-result, not numTurns alone.

## 09:42
Excluded (`skip-no-mention`).

## Proxy
`off`. No new fault by executor. No messages sent.
