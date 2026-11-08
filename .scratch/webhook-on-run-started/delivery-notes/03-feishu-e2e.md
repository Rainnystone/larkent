# Delivery notes: 03-feishu-e2e

Date: 2026-11-08 (Asia/Shanghai). Code: PR #69 head `18558f19`. Test bridge `test-bot` (agent cursor), Bot Arena, test account 「Agent测试专员」, real @Test Bot mention. Receiver: Keeper (Dungeon Master) task-follow-up.

## Run A (short task)
- run_id `01054287-0e36-4eae-8063-f4339a1b48d7`, task_key `88c8d99879eacd29bde66df1d1020103`.
- started 14:31:52, completed 14:32:40. No plugin errors in bridge log.
- Receiver got `key` = task_key and full run_id. Task finished before first check, so no patrol (expected).

## Run B (long task, ~7 min)
- run_id `2a07bb68-ff0e-4694-abad-2cf2358a25d3`, task_key `41f9b79653d3af8ea0c4e83588d24c38` (new key for a new message).
- started 14:35:40, completed 14:42:52. No plugin errors.
- Receiver created one 5-min temporary patrol, verified reply delivered and typing cleared, record `terminal-completed`, patrol self-deleted.

## Not proven here
- Exact single HTTP POST count and absence of message text in the raw payload: covered by unit tests only, raw payload not captured.
- Restart replay with the same message_id: not exercised (no safe mechanism on test bridge).

## Receiver-side note (not a plugin concern)
- A webhook-triggered routine run cannot create another routine; Keeper relays to its main session to create the patrol.
