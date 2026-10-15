# 5: per-adapter CLI 签名表、golden stderr、脱敏文案、有界 stderr

**Blocked by:** 2

**Status:** ready-for-agent

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 5.5, 附录 A

## What to build

- descriptor 新增 `stderrSignatures`（pattern、CLI 版本、outcome、retriable、needsHuman、脱敏用户文案）；共享代码一处应用。
- runner：stderr 有界缓冲（头尾各 N KB），退出 0 也交给分类；不再用 500 字符截断做匹配；修复 `stderrChunks` 无界增长。
- 填附录 A 的所有已观测签名；grok/kimi 标注“仅合成”。
- 卡片显示脱敏文案，原始 stderr 只进本地日志；未知 → `unclassified` + 计数日志。

## Test plan

- golden 夹具 `tests/fixtures/goldens/stderr/<kind>/*.txt`，每条观测签名一个，断言 outcome。
- agy partial output（exit 0）→ `partial`；cursor auth → `failed(auth-required)` + needsHuman；cursor stall → `failed(transient-upstream)` retriable；agy `error: interrupted` 无 stop 请求 → `interrupted(external-signal)`。
- 未知 stderr → `unclassified`，日志计数。
- 大量 stderr（如 50 MB 流）内存有界，头尾保留。
- 卡片不含原始 stderr（含路径/账号形态字符串的夹具断言不出现）。
- `pnpm ci:local` 绿。

## Acceptance criteria

- [ ] 测试计划中的自动化测试先红后绿。
- [ ] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [ ] 无真实 app id / chat id / open id / secret 入库。
- [ ] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- journal、通知。
