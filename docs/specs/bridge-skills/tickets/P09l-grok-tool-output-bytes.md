# Task 9l — P09l Grok 工具进度卡把 Bash 输出显示为十进制字节数组

**Status:** ready-for-agent · bug · P3
**Delivers:** Grok 适配器的工具结果（含 `{type, output: number[]}`、Uint8Array、Buffer 形态）在工具进度卡中显示为可读 UTF-8 文本。
**Found in:** [P09](P09-real-feishu-acceptance.md) 第 3 轮（场景 8、场景 1 续会话），候选版本 `0b55865`（Grok Build）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** profile 开启 `showToolCalls`，Grok 执行一次终端命令（如 bridge tool 调用），展开工具进度卡查看输出。
- **期望：** 输出为可读文本（中文与 JSON 均可读）。
- **实际：** 显示 `{"type":"Bash","output":[40,110,111,100,101,...]}`，即 UTF-8 字节的十进制数组；解码后才是 node 警告和 bridge tool 的协议 JSON。
- **严重度：** P3（仅 `showToolCalls` 开启时可见；不影响回复和状态）。不是本 PR 引入：`953e7bd..0b55865` 之间该文件无改动。

## Evidence

- P09 证据目录中第 3 轮 Grok 工具进度卡的两份卡片回读 JSON（场景 8）；截图对应的卡片展开内容。

## Root cause（`0b55865`）

- `src/agent/grok/jsonl.ts:159` 把 `raw.rawOutput ?? raw.content ?? raw.output` 交给 `serializeToolOutput`。
- `src/agent/grok/jsonl.ts:255-263` `serializeToolOutput` 对非字符串一律 `JSON.stringify`，未识别字节数组/Uint8Array/Buffer，也未识别 `{type, output}` 包装中的字节输出。

## What to build

- `serializeToolOutput` 识别：`Uint8Array`/`Buffer`、全为 0–255 整数的数组、以及 `output`（或同类字段）为上述形态的对象，按 UTF-8（`TextDecoder`，非法序列替换而非抛错）解码为文本；包装对象优先返回解码后的 output 文本。
- 其他对象保持现有 JSON 序列化；不改变字符串路径。

## Acceptance criteria

- [ ] jsonl 单测：`{type:'Bash', output:[...utf8 bytes of 中文+JSON]}`、`Uint8Array`、`Buffer` 三种输入都得到原文；普通对象仍为 JSON；非字节数字数组（如含 256 或负数）不被误解码。
- [ ] 工具进度卡渲染回归：Grok 工具事件的输出为可读文本。
- [ ] `pnpm ci:local` 通过。
