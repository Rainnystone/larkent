# 0a: 统一硬 access 围栏、机器级 app 锁、live 根防护

**Blocked by:** None

**Status:** delivered

## Parent

[docs/specs/run-reliability.md](../../../docs/specs/run-reliability.md) — 5.1, D3

## What to build

- 新增 profile 级围栏开关（名字由实现者定，如 `access.fence.enabled`，默认关）。启用时 DM（`canUseDm`）、群（`canUseGroup`）、文档评论（`src/bot/comments.ts:208` 目前直接 `ok: true`）、会议、卡片点击（`src/card/dispatcher.ts`）五个入口统一调用一个函数：chat ∈ `allowedChats` **且** sender ∈ `allowedUsers`；owner、admin 不豁免。未启用时行为与 master 完全相同。
- 机器级 app 锁：路径与 `LARK_CHANNEL_HOME` 无关（如 `${XDG_RUNTIME_DIR:-~/.cache}/larkent/locks/app/<sha256(appId)>`），沿用现有 runtime lock 的 stale 判断。第二个持锁者启动失败，错误不打印明文 app id。
- live 根防护：实例被声明为 test（如 `LARKENT_INSTANCE=test` 或 profile 字段）时，若解析出的数据根等于默认 live 根（`~/.lark-channel`）或其内部路径，拒绝启动。
- 不改 keystore（评审指出同一 OS 用户可推导密钥；由 0b 的默认 fake CLI 缓解，记录为残余风险）。

## Test plan

- unit `tests/unit/policy/access.test.ts`：围栏开启时，对 5 个入口参数化：(chat ∈, user ∈) 允许；(chat ∉) 拒绝；(user ∉) 拒绝；owner 不在 `allowedUsers` → 拒绝；admin 同理。围栏关闭时现有用例全部不变。
- unit comments：评论 @bot 在围栏开启且 sender 不在 `allowedUsers` 时被拒，日志带 reason。
- unit card dispatcher：围栏开启时，不在名单的点击者被拒。
- process/integration：两个不同临时数据根、同一假 app id 启动第二个 → 明确错误退出；第一个退出后第二个可启动；stale 锁可回收。
- unit：test 实例 + 数据根为 live 根 → 拒绝启动；非 test 实例不受影响。
- `pnpm ci:local` 绿。

## Acceptance criteria

- [x] 测试计划中的自动化测试先红后绿。
- [x] 改变行为的部分有 profile 开关，关闭时与 master 一致。
- [x] 无真实 app id / chat id / open id / secret 入库。
- [x] `pnpm ci:local` 绿；delivery note 填写（含 test bridge 证据，脱敏）。

## Out of scope

- keystore 加固、独立 OS 用户/容器；0b 的工具代码。
