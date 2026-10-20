# Task 9ac — P09ac Profile 模型列表含不存在的 `grok-build`，错误被泛化

**Status:** done · fixed in #52 by 3dd6658; live FX-ac PASS @b4cda3f（2026-10-20） · bug · P2
**Owner:** local Grok Build
**Audit verdict:** PARTIAL（Grok Build 只读审计 G3，复核于 `93a6c75`（#52））
**Found in:** Grok CLI 只读审计（grok 1.0.41），2026-10-20
**Blocked by:** None

## Root cause

`grokMetadata.models` 列出 `grok-build`（grok 1.0.41 不存在），缺 `grok-4.7`（默认）与 `grok-4.7-build-fast`。选中后 `-m grok-build` exit 1，错误 `unknown model id` 被卡片替换为通用 `agent 运行失败`。部分成立：生产 grok profile 与 p09-grok profile 均未配置模型（走默认），目前不触发。

**位置：** `src/agent/grok/metadata.ts:33-38`；`src/bot/channel.ts:~3160-3173`；`src/agent/cli-signatures.ts`

## Repro

bridge argv + `-m grok-build`（样本 `s5-bad-model.jsonl`）：exit 1，单行 `{"type":"error","message":"Couldn't set model 'grok-build': Invalid params: \"unknown model id\"..."}`。

## Acceptance criteria

- [ ] 模型列表只含 `grok models` 实测存在的 id（含 `grok-4.7`）。
- [ ] unknown model 错误在卡片上保留可读原因，且不可重试。

## Test requirement

- fixture 记录 `grok models` 输出，断言每个非默认 `models[].value` 在列表中；s5 经 translator+卡片 reducer 后可见错误含 `unknown model id`。
- 只运行该定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
