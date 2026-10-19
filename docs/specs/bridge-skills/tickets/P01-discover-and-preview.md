# Task 1 — P01 内置 automation 的发现、查询与排期预览

**Status:** ready-for-agent · 待代码实施授权
**Delivers:** 飞书人工消息触发 agent 按需读取内置 automation，通过真实客户端查询任务或预览排期，在同一轮解释结果并修正参数。
**Blocked by:** None
**Worker class:** judgment

## What to build

完成第一条只读业务链：飞书消息 → 插件简介 → 需要时读取 skill → CLI 工具请求 → bridge 结构化结果 → 本轮回复。以 Codex 验证第一条真实 runtime 路径；接口按六种 CLI 的共同 shell 能力设计，不引入 Codex 原生工具协议。创建及其他写操作在 P02/P05 完成前明确不可用。

## Interfaces and boundaries

- 遵循 [共同契约与依赖](README.md)及[规格 D1–D6、T1–T2](../../bridge-skills.md)。内置包使用正常 plugin 描述和读取接口，不为 automation 硬编码另一套内容加载器。
- 客户端提供插件列表、能力目录、内容读取、automation schema、当前群任务查询和结构化排期预览。薄客户端只负责传输；排期校验和计算归 automation 模块。
- 优先复用已有结构化排期和业务校验；如需提取共享业务入口，在本票内用现有人工命令回归保护行为，不复制第二套时间解析器。
- 本轮可信上下文、传输和取消规则随这条真实调用链交付；不单独做没有用户路径的通用 RPC 框架。

## Acceptance criteria

- [ ] 初始 prompt 只有短契约、当前事实与内置插件简介；按需读取才出现 skill/参考内容，明确点名可直达。发布构建产物包含内置包，脱离源码目录也能读取。
- [ ] 实际子进程通过客户端得到机器可读结果；stdin 支持含引号、换行和 shell 元字符的内容，stdout 与日志分离。schema 与校验来自代码。
- [ ] 一次性、每日、工作日、指定星期、固定间隔均可预览，返回时区、起止边界、后续时刻及总次数。固定时钟三天案例保持 09:00、三次、22 日 00:00 的排他结束边界。
- [ ] 参数不合法或缺字段在本轮返回确定性结果，无写入；测试 agent 读取实际响应后修正，不手工注入成功 tool_result。
- [ ] profile、群、actor 和 run 类型来自 bridge；请求不能覆盖。关闭功能、非适用会话、伪造或失效凭据明确拒绝；不使用 supervisor 管理 token。
- [ ] run 完成、停止或取消后客户端失去调用资格；新会话及续会话取得当前调用信息，不沿用旧凭据。
- [ ] 查询与预览不发送确认卡、不新建任务；既有人工聊天命令仍通过原有回归。

## Verification loop

1. 从 `startChannel` 写失败用例，驱动真实客户端读包、预览、收错和修正；补充真实进程的输入输出、归属与失效 run 用例。
2. 实现这条最小完整链，验证固定时钟排期与任务查询；检查打包后的可读性及目录/调用可用性一致。
3. 运行相关 integration/process 测试与 `pnpm ci:local`；记录一次 Codex 新会话和续会话真实调用结果。真实飞书全矩阵由 P09 验收，不能以此票替代。

**Spec coverage:** A02、A03（内置包）、A07、A08、A09（预览）；A06 的首条 runtime 路径。
