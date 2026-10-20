# Task 9ab — P09ab P09u 不完整：Grok 工具进程自设 NO_COLOR+FORCE_COLOR，Node 警告仍进工具卡

**Status:** done · fixed in #52 by 738e145; live FX-ab PASS @b4cda3f（2026-10-20） · bug · P1
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G2，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

P09u 只删 grok 进程的 `NO_COLOR`。Grok 1.0.41 在工具子进程中自行设置 `FORCE_COLOR=1`、`NO_COLOR=1`、`CLICOLOR_FORCE=1`、`TERM=xterm-256color`，与父进程无关。Node 因此打印 `The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set`。P09t 只剥 ANSI，警告文本保留。

**位置：** `src/agent/grok/adapter.ts:82-88`；`src/agent/lark-channel-env.ts:14-16`；`src/agent/grok/jsonl.ts:278-298`；`tests/unit/agent/grok-env.test.ts`（只测 spawn env）

## Repro

真实样本 `s2-clean-color-env.jsonl`（父进程已删全部颜色变量、`TERM=dumb`）：completed `run_terminal_command` 的 `rawOutput.output` 仍含警告行（2 处）。

## Acceptance criteria

- [ ] Grok 工具卡（含 `node "$LARK_BRIDGE_TOOL_CLIENT"`）不出现该 Node 警告。
- [ ] 修法需对 Grok 自注入的 env 有效（例如 bridge tool client 自身用 `node --no-warnings`/在 tool client 内清 `NO_COLOR`，或仅剥离该精确两行警告头），并写明取舍。
- [ ] live 复验一次。

## Test requirement

- 用 s2 completed update 作为 fixture，经 `GrokJsonlTranslator` + `renderCard`：断言卡片含 `RED`，不含 `NO_COLOR' env is ignored`、不含 `\u001b`。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
