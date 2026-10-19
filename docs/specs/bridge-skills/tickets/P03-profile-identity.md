# Task 3 — P03 自动任务沿用 profile 的 bot/user 身份

**Status:** ready-for-agent · 待代码实施授权
**Delivers:** 已有自动 agent 任务能使用 profile 已授权的 bot 或 user 身份，正常授权失败如实报告，运行过程不修改 profile 的认证或身份配置。
**Blocked by:** None
**Worker class:** judgment

## What to build

在现有自动任务执行链修正 bot-only 实现。此票可独立于新插件与工具入口验收，因此没有 P01/P02 前置依赖。任务正文、适用 skill 与模型决定业务操作使用哪个已授权身份；不新增任务创建者 OAuth 模型或 bridge token 副本。

## Interfaces and boundaries

- [规格 D8](../../bridge-skills.md)包括 PR51 的 `0624458` 补充：区分使用已有身份与修改 profile 认证配置，自动任务继承同一 profile 的运行环境和 lark-cli 配置目录。
- 清除 prompt、工具事件检查、状态文案与运维说明中的 bot-only 冲突。历史业务类别禁令不自动成为本版政策；既有最终回复归属、平台权限和明确配置约束继续成立。
- lark-cli 负责 token 刷新、加锁及写回校验；bridge 不自行刷新、复制或另存凭据。核对可支持该机制的依赖版本和部署条件，明确记录实际验证版本，不把截图结论当作所有环境已验证。

## Acceptance criteria

- [ ] 在已有自动任务上，`--as user` 等合法身份选择不触发旧 user-identity 中断；bot 操作仍可用。创建者与授权主体不同的测试使用 profile 授权，并保留创建者记录。
- [ ] 无人值守运行继续拒绝登录、登出、strict-mode 与默认身份等认证/身份配置变更；读取认证状态不与配置修改混为一谈。提示词不引导自动任务执行人工会话的授权收敛流程。
- [ ] 人工对话与自动任务实际子进程使用同一个 profile 配置目录；不新增 token 文件，不覆盖该身份环境、不借其他 profile 凭据，任务结束也不改变人工会话配置。
- [ ] 以可控凭据存储替身或受控环境证明并发使用沿用 CLI 自身刷新机制；只记录版本、路径归属及结果，不输出凭据。缺少必要 CLI 能力时给出明确依赖诊断。
- [ ] 授权缺失、失效、平台拒绝等走真实失败路径，不自动登录、不伪装成功、不向群发授权链接。
- [ ] 更新相关身份、运维文案和回归；不增加组织风险引擎、账号迁移或逐任务重新授权流程。工具事件 guard 的能力边界仍如实描述，不能宣称隔离完整 shell。

## Verification loop

1. 先用现有自动任务链证明 user 操作被错误拦截，并测试认证配置变更仍应拒绝。
2. 修正 prompt/guard/环境接线与依赖诊断，观察真实子进程的 profile 归属和配置不变性；复验授权失败及人工会话。
3. 运行相关自动任务 integration、身份环境 process/unit 回归及 `pnpm ci:local`。使用受控实例记录 bot/user 操作与 CLI 版本，后续 P09 验证新入口的完整链。

**Spec coverage:** A13、A14；D8 的配置变更、环境与刷新职责补充。
