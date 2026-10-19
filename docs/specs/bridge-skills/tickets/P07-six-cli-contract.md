# Task 7 — P07 六种 CLI 使用同一完整调用契约

**Status:** ready-for-agent · 待代码实施授权
**Delivers:** Claude、Codex、Kimi、Grok、Cursor、Antigravity 都能发现插件、调用完整 automation 能力并在本轮处理结果，新会话和续会话行为一致。
**Blocked by:** [P04](P04-create-agent-task.md)、[P05](P05-manage-tasks.md)、[P06](P06-external-plugins.md)
**Worker class:** judgment

## What to build

把已经可验证的完整业务链作为六种 runtime 的共同契约，补齐启动、环境、续会话和停止接线。重点是同一个客户端接口在六种 native 工具循环中实际工作，不为每家实现一套原生插件注册或工具协议。

## Interfaces and boundaries

- 遵循[规格 D4–D5、T2、T4](../../bridge-skills.md)和[共同契约](README.md)。六种 CLI 平等，Codex 只是 P01 的先行验证对象。
- 共用逻辑在共享入口处理，adapter 仅处理本身必须的进程差异；现有访问模式与用户授权保持有效。
- P04/P05/P06 均完成后才具备本票的完整测试对象；这不是要求前几票把六种 CLI 的所有问题提前做完。

## Acceptance criteria

- [ ] 六种 adapter 的新/续会话、人工/自动 run 均获得当前简介、正确运行环境和有效凭据；过期上下文不会继续操作。
- [ ] 共用 process 矩阵从实际子进程完成读取、查询、预览、写操作回执和结果查询，覆盖非法输入、失效 run 与日志分流。
- [ ] 每种真实 CLI 至少有新会话与续会话的插件读取、正常调用和一次本轮参数修正证据；模型读取真实结果后再回复，无人工伪造成功反馈。
- [ ] 普通包脚本、automation 与原生 CLI 插件并存；不为读取或调用静默提升 trust，不要求用户安装某一家原生插件。
- [ ] 本机传输在目标 Linux/macOS/Windows 的 process 验证中可用，命令启动与包含空格/特殊字符的输入路径不依赖单一 shell。
- [ ] 缺少某 CLI、授权或平台测试环境时标为未验证并保留未完成验收项，不以其他 runtime 的结果替代。

## Verification loop

1. 在共用契约矩阵中暴露 adapter/续会话/环境差异，先有失败再修接线；真实客户端必须跑在子进程。
2. 按各 CLI 已有真实 smoke 约定做受控验证，记录 runtime/模型/版本与结果；这里证明 runtime 工具循环，完整飞书交互另由 P09 验收。
3. 运行目标平台 process 检查、相关 integration 及 `pnpm ci:local`；整理六行证据矩阵，不写笼统的“六种都兼容”。

**Spec coverage:** A06、A07、A08、A12；A01–A05 在六种 runtime 的共用接线；T4 runtime 部分。
