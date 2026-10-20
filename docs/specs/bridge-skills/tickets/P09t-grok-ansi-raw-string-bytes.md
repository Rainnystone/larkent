# Task 9t — P09t Grok 原始字符串 / 字节数组 rawOutput 未剥离 ANSI

**Status:** done · fixed in #52 by 567fe36; live FX-t PASS @b4cda3f（2026-10-20） · bug · P2
**Owner:** local Grok Build
**Delivers:** 详细 CoT 与工具卡中 Grok 工具输出不含 ANSI 转义序列。
**Found in:** 真实飞书测试 bridge，代码 head `6dd0e44`（#52），2026-10-20 live 回归
**Worker class:** mechanical
**Blocked by:** None
**Source:** Codex review finding #2

## Bug

- **场景：** agent 用 `node -e` 打印数值（Node 默认对数字着色）。
- **期望：** 输出纯文本。
- **实际：** 详细 CoT（`src/bot/cot.ts:386`，`truncateCot(evt.output ...)`）显示 `\u001b[33m1792652400000\u001b[39m`。
- **严重度：** P2（可见污染，Codex review 标为需修）。

## 真实事件形状

`tool_call_update`，`status: "completed"`，`rawOutput: {"type":"Bash","output":[27,91,51,51,109,...]}`（字节数组，解码后为 `\u001b[33m…\u001b[39m`）。样本见 `/workspace/p09-evidence/grok-raw-samples.jsonl`（`sample: "P09t"`）。

## Root cause

- `src/agent/grok/jsonl.ts:265-277` `serializeToolOutput`：`typeof value === 'string'` 直接返回；`decodeUtf8Bytes(value)` 及 `value.output`/`value.content` 的字节解码结果也直接返回。只有走 `JSON.stringify` 的分支才调用 `stripVTControlCharacters`。

## What to build

- 所有返回路径（原始字符串、顶层字节数组、包装的 `output`/`content` 字节数组）统一经过 `stripVTControlCharacters`。

## Acceptance criteria

- [ ] 字符串、顶层字节数组、`{output: bytes}`、`{content: bytes}` 四种形状都不含 ESC。
- [ ] 非 ANSI 的多字节 UTF-8（中文）保持不变。
- [ ] live 复验详细 CoT 无 ANSI。

## Test requirement

- Grok jsonl 解析测试中用真实 P09t 字节数组构造用例，断言 `tool_result.output` 不含 `\u001b`。
