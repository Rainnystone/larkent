# Task 9ag — P09ag Grok 恢复失败/未知模型被归为通用可重试失败

**Status:** done · fixed in #52 by a2169ce（2026-10-20） · bug · P2
**Owner:** local Grok Build
**Audit verdict:** CONFIRMED（Grok Build 只读审计 G7，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`grokStderrSignatures` 只有一条合成的 auth 规则。真实失败（`-r` 不存在的 session → stderr 404、`unknown model id`）归为 `failed/unclassified/retriable:true`，卡片提供“继续”，而继续会再次 404。

**位置：** `src/agent/grok/stderr-signatures.ts:3-12`；`src/agent/runner/jsonl-cli-runner.ts`（fail 附 stderr）；`src/bot/run-outcome.ts`；`src/bot/interruption-notice.ts`

## Repro

样本 `s4-bad-session.err`（`-r 00000000-0000-4000-8000-000000000099`：exit 1，stdout 空，stderr 404）、`s5-bad-model.jsonl`、`s6-continue-empty.err`。

## Acceptance criteria

- [ ] 新增实测签名：session 404、`No session found for current directory`、`unknown model id`，`retriable:false` 且有专用 userMessage。
- [ ] 404 resume 不提供“继续”，或继续时放弃旧 session 新开。

## Test requirement

- 用 s4/s5 输出断言分类为不可重试、userMessage 专用、`planInterruptionNotice` 不提供 continue。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
