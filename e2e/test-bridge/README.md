# Isolated test bridge

POSIX-only harness for run-reliability work. It starts a **test** instance on
`~/.lark-channel-e2e/<instance>`, enables the 0a access fence, and injects
faults from outside production code (shim path, `HTTPS_PROXY`, signals).

Default agent binary is a scripted JSONL fake. Pass `--real-cli` to point the
shim at a real CLI.

## Layout

| Path | Role |
| --- | --- |
| `e2e/test-bridge.example.json` | Placeholder template. Copy to `e2e/.local/test-bridge.json`. |
| `e2e/.local/` | Gitignored. App secret, tester token, real chat/app/open ids. |
| `e2e/test-bridge/shim.sh` | `agent.binaryPath`. Passthrough uses POSIX `exec`. |
| `e2e/test-bridge/proxy.ts` | CONNECT proxy: disconnect, blackhole, eproto, eai_again, slow. Optional `--host` selects Feishu vs model egress. |

Tester credentials live in `testerConfigDir`, which must be **outside** the
test data root. Never use `~/.lark-channel`.

## Commands

```
pnpm e2e:up -- [--config e2e/.local/test-bridge.json] [--real-cli]
pnpm e2e:down
pnpm e2e:fault -- arm cursor-stall --run-id 2
pnpm e2e:fault -- arm hang --sticky
pnpm e2e:fault -- arm delay:3
pnpm e2e:fault -- proxy disconnect|blackhole|eproto|eai_again|slow|off [--host open.feishu.cn]
pnpm e2e:fault -- kill-cli --child-only
pnpm e2e:fault -- kill-cli --process-group
pnpm e2e:fault -- ws-freeze          # SIGSTOP wake-up helper only
pnpm e2e:fault -- ws-unfreeze
pnpm e2e:send -- --text "continue"
pnpm e2e:read
pnpm e2e:scenario -- redelivery-short-gap [--gap-sec 25]
pnpm e2e:scenario -- journal-kill-group [--up]
pnpm e2e:scenario -- cursor-stall-notice
pnpm e2e:scenario -- host-sleep-cli-self-send [--freeze-ms 8000]
```

`down`, `ws-freeze`, and `kill-cli` read the pid file, refuse a process whose
cmdline is not the test instance, and fail loudly if that process is already
dead.

`e2e:up` sets `HTTPS_PROXY` only on the test-bridge child. FeishuLink's
authenticated probe uses the same SDK HTTP client as replies (`respectProxyEnv`
+ `httpTimeoutMs`), so a `proxy blackhole --host open.feishu.cn` is visible to
the link.

`eai_again` as a start mode advertises an unresolvable proxy host. After
`e2e:up` the proxy is already bound; `e2e:fault proxy eai_again` then
destroys CONNECT sockets (not a second DNS failure).

## Fault modes (shim)

One-shot per matching run id unless `:sticky` / `--sticky`.

- `cursor-stall`
- `cursor-auth` (stderr only; never logs out a real CLI)
- `agy-print-timeout`
- `agy-interrupted`
- `hang`
- `delay:<seconds>` then `exec` the target

## First experiment

`redelivery-short-gap` drops the proxy for 20–30 seconds while the tester
sends an @ message, then restores. Put the redacted conclusion (WS redelivery
vs backfill) in the docs-track delivery note. Do not commit ids or tokens.

`host-sleep-cli-self-send` SIGSTOPs the test bridge mid-run. That is a
**process freeze, not OS sleep** (S7): on Linux `hostSuspended` must stay
false unless `/proc/uptime` vs monotonic actually grew, so runs are not
sleep-reviewed. Real-sleep acceptance is a manual lid-close on the user's
Mac (`kern.waketime` / `kern.sleeptime`). The scenario still records whether
a CLI self-send skipped the extra final reply (`skip-cli-already-sent` /
intake skip-self) and whether Cursor `connection`/`retry` logged as
`stream-reconnect`. Use `--real-cli` when the CLI itself posts to the group.

## Safety

- Production code has no test hooks. This tree is not in the npm `files` list.
- Changing live behavior still goes through profile flags (0a fence is off by
  default on master).
- Do not touch live bridges or the live data root.
