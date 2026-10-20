# Task 9aq — P09aq 失败分类输入错误：stderr 为空串时不回退终态消息（CLI 无关）

**Status:** done · fixed in #52 by 9bd87b2, af33ded（2026-10-20） · bug · P2
**Owner:** Codex（CLI 无关）
**Audit verdict:** CONFIRMED（#52 Codex 定向 review，`7514c1e`，已接受）
**Found in:** #52 Codex scoped review，2026-10-20
**Blocked by:** None
**Merged in:** [P09ar](P09ar-terminal-text-crlf.md)（CRLF）、[P09ap](P09ap-grok-404-signature-scope.md)（404 签名范围）并入本票

## Root cause

失败分类的输入文本是错的。两个调用点都用 `stderrSnapshot ?? event.message`：

- `src/bot/channel.ts:3161`
- `src/runtime/run-executor.ts:346`

stderr 为空时快照是 `""` 而不是 `undefined`，`??` 永不回退，终态消息从不参与签名匹配。例如 Grok unknown-model 错误以 JSONL `error` 出现在 stdout/终态消息上、stderr 为空，于是落入 `cardUserMessage` 的 `UNCLASSIFIED_USER_MESSAGE`，用户看不到模型指引。该问题对所有 CLI 通用。

## Codex finding (verbatim)

> **Match unknown-model errors from the terminal event**
> 
> The observed unknown-model failure is emitted as a Grok JSONL `error` on stdout, but the outcome paths use `run.stderrSnapshot ?? event.message`; an empty stderr snapshot is `""`, not `undefined`, so the terminal message is never passed to this signature. The new rule therefore does not classify the real failure and users still receive the generic error instead of the model guidance; fall back on the terminal message when stderr is empty or match both sources.

## Fix

1. **统一分类文本：** 新增一个 CLI 无关的辅助函数，由 stderr 快照与终态消息共同构造一份分类文本（两者都参与；任一为空/仅空白时不影响另一方）。`channel.ts:3161` 与 `run-executor.ts:346` 两个调用点都改用它，不得各自拼接，不按 CLI 品牌分叉。
2. **CRLF（原 P09ar）：** `src/agent/terminal-text.ts` 的 `stripTerminalText`（Grok jsonl 文本与所有 CLI 的 stderr 都经它处理，见 `src/agent/runner/jsonl-cli-runner.ts:568`）把 `\r\n` 视为换行，只有独立 `\r` 做行覆盖。
3. **404 签名（原 P09ap）：** `src/agent/grok/stderr-signatures.ts` 的 `/session get failed:\s*404|404 Not Found/i` 收窄为只匹配 `session get failed: 404`，去掉泛化的 `404 Not Found` 分支。

## Acceptance criteria

- [ ] Grok unknown-model 错误只出现在 stdout/终态消息、stderr 为空 → 正确分类，输出模型指引，而非 `UNCLASSIFIED_USER_MESSAGE`。
- [ ] 至少一个非 Grok CLI 的等价场景（签名文本只在终态消息、stderr 为空）同样被正确分类。
- [ ] `"first\r\nsecond\r\n"` 经 `stripTerminalText` 保留 first/second 两行。
- [ ] 独立 `\r` 进度条仍按覆盖处理，只留最后一段。
- [ ] 仅含无关 `404 Not Found` 不再匹配“会话不存在”；`session get failed: 404` 仍匹配。
- [ ] stderr 非空时现有分类结果不变。

## Test requirement

- 回归测试必须覆盖受影响的调用方：`channel.ts` 与 `run-executor.ts` 两个调用点各自有测试，而不只测辅助函数。
- `stripTerminalText` 的 CRLF / 独立 `\r` 用例；404 签名正反用例。
- 只运行定向 vitest 文件（`--maxWorkers=1 --minWorkers=1`），不跑全量。
