# Task 9k — P09k 插件目录不存在时返回笼统的 invalid-package

**Status:** ready-for-agent · bug · P3
**Delivers:** 配置指向不存在的插件目录时，诊断给出具体、已文档化的代码（如 `missing-root`），并带出问题 root。
**Found in:** [P09](P09-real-feishu-acceptance.md) 场景 8，候选版本 `0b55865`（Kimi）
**Worker class:** mechanical
**Blocked by:** None

## Bug

- **场景：** plugins.json 中一项指向不存在的目录。
- **期望：** 诊断指向具体问题；`docs/operations.md` 列出的代码可据以修复。
- **实际：** 返回 `invalid-package`，该代码不在 operations 文档的诊断列表中，也不说明是目录缺失。
- **严重度：** P3。

## Evidence

- P09 证据目录 `read-kimi-4.json`；Kimi profile jsonl 中 plugins.list 的诊断输出。

## Root cause（`0b55865`）

- `src/plugins/catalog.ts:38` `realpath(root)` 在目录不存在时抛 `ENOENT`，未被转换为具体代码。
- `src/plugins/catalog.ts:91-93`：不在白名单内的错误统一落为 `invalid-package`。
- `docs/operations.md:161` 的诊断列表没有 `invalid-package`，也没有目录缺失代码。

## What to build

- `realpath` 的 `ENOENT`/`ENOTDIR` 映射为 `missing-root`（root 存在但不是目录可为 `invalid-root`）；诊断带 `root`。
- `invalid-package` 保留为真正未知错误的兜底，并在 operations 文档中列出、说明含义；同时把新代码加入文档列表。

## Acceptance criteria

- [ ] catalog 单测：不存在的 root → `missing-root`；root 为文件 → `invalid-root`（或文档化的等价代码）；未知异常 → `invalid-package`。
- [ ] `docs/operations.md` 诊断列表包含上述代码，并有对应测试或文档一致性检查通过。
- [ ] `pnpm ci:local` 通过。
