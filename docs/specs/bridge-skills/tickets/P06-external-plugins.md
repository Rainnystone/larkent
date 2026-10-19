# Task 6 — P06 外部插件包的加载、使用与更新

**Status:** ready-for-agent · 待代码实施授权
**Delivers:** 维护者在主机准备兼容插件后，各 profile 的 agent 可以发现、按需读取并调用其中脚本；依赖和版本问题可诊断，正常更新不混用内容。
**Blocked by:** [P01](P01-discover-and-preview.md)
**Worker class:** judgment

## What to build

把 P01 的内置包通路扩展到明确安装根下的外部包。用 Matt 类纯 skill bundle 和 Lark 类依赖已有命令的 bundle 验证受支持的 Codex manifest 子集；新增普通脚本能力无需修改 bridge 业务代码。此票与 automation 写操作没有依赖。

## Interfaces and boundaries

- 完整落实[规格 D2–D4](../../bridge-skills.md)，遵循[共同契约](README.md)。加载器归一化名称、版本/固定修订、用途、skills 及资源；默认同部署所有 profile 可发现。
- 管理员在产品外准备本地目录或固定 Git 检出；本票不做下载器、安装器、市场、MCP、hooks 或常驻进程托管，也不继承 CLI 全局插件安装。
- 依赖和实际可用范围属于 catalog 契约。插件脚本由 native runtime 的现有工具执行，不经通用代码执行代理、不提升 CLI trust。

## Acceptance criteria

- [ ] 两类兼容样本可经真实客户端发现和按需读取，脚本与资源按包内关系定位，脚本实际返回可核对的结果；安装一次供多个 profile 使用。
- [ ] 默认 prompt 只有插件简介；点名唯一插件/skill 可直达，同名/别名冲突返回候选，不按扫描顺序覆盖。正文与全量 skill 索引不常驻。
- [ ] 缺 manifest、无效元数据、重名、不支持的必需内容、缺失命令依赖明确诊断；独立可用内容可用，不假装整个包成功就绪。
- [ ] 包外路径、绝对路径逃逸和符号链接目标经确定性检查；内容读取与资源定位均遵守声明范围，不宣称能隔离完整 shell。
- [ ] 一个 run 使用同一版本。新目录部署并重启后，新 run 及续会话获取生效内容；旧引用失效有明确结果，不混合新旧正文或原地热替换。
- [ ] 普通坏包不拖垮聊天或其他插件；内置 automation 不可用时准确报告。发现可用性与实际读取/调用一致。
- [ ] agent-facing 入口无安装、更新、卸载、启停命令；原生 CLI 插件继续独立工作。更新 setup/运维说明，清楚描述版本、依赖和加载诊断。

## Verification loop

1. 以临时真实包建立 catalog interface 失败用例，再经消息链和真实客户端完成读取及脚本调用；不能只测私有扫描器。
2. 覆盖坏包、缺依赖、歧义、越界、双 profile、版本切换与续会话；检查 prompt 内容及实际脚本输出。
3. 运行相关 catalog/integration/process 测试及 `pnpm ci:local`，从构建后的安装产物验收内置与外部包共用接口。

**Spec coverage:** A01、A02、A03、A04、A05、A16。
