# Task 4 — P04 创建并运行可读取插件的 agent 自动任务

**Status:** ready-for-agent · 待代码实施授权
**Delivers:** 用户通过新工具创建 agent 自动任务，确认后到期运行；任务按需读取插件，使用所属 profile 的授权完成操作，真实执行结果交付到原会话。
**Blocked by:** [P02](P02-create-reminder.md)、[P03](P03-profile-identity.md)
**Worker class:** judgment

## What to build

在已经可靠的创建契约上增加 agent 类型，复用既有自动执行、会话归属和结果交付。让自动运行获得与人工 IM 一致的插件发现/读取方式，同时按 run 类型裁定可调用能力。

## Interfaces and boundaries

- 遵循[共同契约](README.md)与[规格 D4–D8](../../bridge-skills.md)。复用 P02 操作回执和 P03 身份语义，不复制创建状态机或认证配置。
- 自动任务可以读插件完成业务，但不因有 shell 就获得创建或管理调度的资格；服务端按真实 run 类型校验，不能只靠隐藏目录或 prompt。
- 本票使用内置包或测试资源验证自动运行接线；外部兼容包的产品加载由 P06 完成，因此不依赖 P06。

## Acceptance criteria

- [ ] 新入口创建 agent 类型任务，遵循 agentTasks 开关、工作目录及当前群组/话题条件；未满足条件的请求在本轮明确反馈，无幽灵任务。
- [ ] 任务使用真实结构化排期，确认后实际启动 runtime；开始运行、成功、失败与结果交付分别可观察。
- [ ] 自动运行初始只见简介及短契约，实际客户端能按需读取内容；调用凭据与该 run 绑定，不能复用创建时的人工 run 凭据。
- [ ] 自动运行递归创建/替换/删除/暂停/恢复调度会被服务端拒绝；合法内容读取和业务操作不受影响。
- [ ] profile 身份、创建者、工作目录及最终回复归属正确；bot/user 操作、授权失败、空结果、停止和交付失败均保持真实状态，不提前声称完成。
- [ ] 对同一创建请求的重复提交继续复用 P02 回执；运行失败与“任务未建立”不混为一谈。

## Verification loop

1. 通过真实客户端写 agent 创建失败用例，点击确认并推进时钟，观察真正的自动 run 和内容读取。
2. 验证业务输出、run 结束资格撤销、递归管理拒绝、身份及既有交付恢复；fake adapter 必须实际读取工具响应。
3. 运行相关自然语言创建/自动任务/交付 integration 与 process 测试及 `pnpm ci:local`；记录参考 CLI 的一次完整自动执行。

**Spec coverage:** A06（自动 run）、A07、A10（agent 创建）、A12、A13、A14。
