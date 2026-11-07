# webhook-on-run-started

Opt-in telemetry adapter. The bridge stays silent unless you point `LARK_CHANNEL_TELEMETRY_MODULE` at this file and set `LARK_RUN_STARTED_WEBHOOK_URL`.

This is **Optional telemetry**, not a chat skill package. It POSTs one versioned JSON object when a run starts. The body never includes the message text.

## Enable

```sh
export LARK_CHANNEL_TELEMETRY_MODULE=/absolute/path/to/plugins/webhook-on-run-started/index.mjs
export LARK_RUN_STARTED_WEBHOOK_URL=https://example.invalid/hook
```

Optional:

| Variable | Role |
| --- | --- |
| `LARK_RUN_STARTED_WEBHOOK_KEY` | Sent as both `Authorization: Bearer <key>` and `X-Automation-Key` |
| `LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS` | POST timeout, default 4000, clamped 3000–5000 |
| `LARK_RUN_STARTED_BOT_NAME` | Payload `bot`; defaults to the Feishu app id |

If the URL is unset, every method is a noop and the adapter prints **one** startup warning. Never put a real webhook URL or key in the repo, tests, fixtures, or logs.

## Payload

```json
{
  "v": 1,
  "type": "run.started",
  "key": "<task_key or run_id>",
  "task_key": "<32 hex chars or null>",
  "bot": "my-bot",
  "scope": "...zzzzzz",
  "chat_id": "...123456",
  "thread_id": null,
  "message_id": "...789012",
  "run_id": "<execution uuid>",
  "agent": "claude",
  "ts": "2026-05-25T00:00:00.000+00:00"
}
```

- `task_key` is the **task**. It is stable across retries and bridge restarts. Different tasks never share one.
- `run_id` is one **execution**. It changes on retry and after a restart.
- `key` equals `task_key` when present, otherwise `run_id`.
- Truncated `chat_id` / `thread_id` / `message_id` are hints only. Missing ids are `null`, never omitted.

## Dedupe

The plugin keeps an in-memory LRU keyed by `key` (`task_key`, or `run_id` when `task_key` is null), TTL about 10 minutes, about 1000 entries. A key seen within the TTL is not sent again. Runs with no `task_key` do not merge: each `run_id` is its own key.

Dedupe is lost on restart. After a restart the same task may wake again with the same `task_key` and a new `run_id`. The receiver must dedupe on `task_key` and must not create duplicate patrols.
