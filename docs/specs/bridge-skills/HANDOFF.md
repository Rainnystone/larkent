# PR51 — Bridge plugins 与 automation 规格交接

Revision 3 · 2026-10-19 · Status: ready-for-agent（规格可进入 to-tickets；尚未授权实施）

## 从这里开始

1. 读 [Revision 3 规格](../bridge-skills.md)：产品边界、User Stories、模块契约与验收。
2. 本文件提供代码导航和旧方案差异；实现时重新核对 checkout 与当前代码。
3. [B01–B07](tickets/README.md) 全部是 superseded 的旧票，不能认领或照旧执行。
4. 下一阶段按新规格运行 to-tickets，生成独立可验收的工作包；本轮不拆新票、不修改代码。

文档载体：[PR #51](https://github.com/Rainnystone/larkent/pull/51)，分支 `docs/bridge-skills`；保留文档专用、不合并的既有约定。用户已明确授权本轮修订并提交到该 PR。测试 seam 已在本轮讨论中确认。

## 本版解决什么

用户用自然语言安排自动化，agent bot 需要知道可用能力和正确调用方法，并在本轮得到工具结果。现有最终回复提案把校验放在 agent 结束之后，无法形成正常工具反馈；仅迁移说明文字不足以解决问题。

新方案以 bridge plugin 为管理单元，支持 skills、资源、脚本/命令，默认先暴露插件简介。automation 是第一个实装，通过共用客户端调用已有业务模块。模型推理留在各 CLI runtime，bridge 返回实际执行状态。bot 与已授权 user 操作均受支持，组织自行管理账号、权限与使用风险。

## 已确认范围

| 本次交付目标 | 延期或范围外 |
| --- | --- |
| 插件包验证、发现、按需读取和普通脚本扩展 | 市场、在线安装、管理界面、MCP、hooks、常驻插件进程 |
| 六种 CLI 的共用调用契约与运行上下文绑定 | 各 CLI 原生插件管理、通用执行平台、主机权限隔离 |
| automation 的结构化请求、同轮反馈、真实状态与既有业务接线 | 原 B04–B06 的其他业务说明迁移、Base 巡检插件 |
| 支持 profile 已接入的 bot/user 身份，创建者单独记录 | 逐用户授权选择、账号迁移、换账号后的任务重确认 |
| 旧提案执行路径退出，已有任务与草稿继续有效 | 永久双协议、借“兼容”保留两套业务处理 |

完整契约以规格为准；表格不替代验收条款。

## 与 Revision 2.1 的关键差异

- skill pool 扩展为 plugin 管理与逐层发现；首层目录按插件展示。
- 正常工具调用替代最终回复中的 `automation_proposal` 执行路径；B02 的下一次用户发言反馈不再是主方案。
- 参数采用结构化排期，直接使用既有排期校验与计算；机器入口不绕回文本时间语法。
- 结果必须来自实际保存/投递/状态，不以预先拼出的成功行或 skill 措辞代替。
- 自动化支持 bot＋user，撤销旧规格的 bot-only 假设。
- 组织运维与账号变更不扩成新产品治理流程。
- 以完整业务链和真实客户端契约为测试重点，覆盖六种 CLI；skill 读取率只是辅助信号。
- 无关的 prompt 搬迁不再成为本次 automation 交付的前置条件。

## 当前代码导航

核对基线为 `master@953e7bdde3549b03bddb8d191d8856683d1dc4c5`，包含 PR49。路径是导航，不代表新设计已经实现。

| 当前事实 | 定位入口 |
| --- | --- |
| agent 结束后解析回复提案，形成结果行再应用 | [channel.ts](../../../src/bot/channel.ts)、[proposal.ts](../../../src/automations/proposal.ts) |
| 既有人工命令、提案校验、确认与任务变更 | [command.ts](../../../src/automations/command.ts) |
| 已有结构化排期、调度与持久化 | [schedule.ts](../../../src/automations/schedule.ts)、[scheduler.ts](../../../src/automations/scheduler.ts)、[store.ts](../../../src/automations/store.ts) |
| 六种 adapter 共用环境注入，尚无本轮业务回调绑定 | [lark-channel-env.ts](../../../src/agent/lark-channel-env.ts)、[agent types](../../../src/agent/types.ts) |
| runner 写入 prompt 后关闭 stdin，事件观察不是工具回填 | [jsonl-cli-runner.ts](../../../src/agent/runner/jsonl-cli-runner.ts) |
| bot-only 提示与工具事件拦截需要按新需求修正 | [bridge-system-prompt.ts](../../../src/agent/bridge-system-prompt.ts)、[policy-guard.ts](../../../src/automations/policy-guard.ts)、[agent-run.ts](../../../src/automations/agent-run.ts) |
| profile 私有 Lark CLI 配置与既有身份策略 | [app-paths.ts](../../../src/config/app-paths.ts)、[identity-policy.ts](../../../src/lark-cli/identity-policy.ts) |

当前 task 保存 createdBy，不保存创建者的 OAuth 授权；现有桥接路径也不会按聊天发送者自动切换个人账号。新规格沿用 profile 已接入身份，不新增逐用户身份模型。

## 测试入口与完成证据

用户已确认规格 T1–T4：以 `startChannel` 完整链为主，额外测试 plugin catalog interface 和 CLI process interface；六种 CLI 均需覆盖。只观察最终文案或 fake 成功响应不能证明新通道有效。

可复用范式：

- [自然语言创建](../../../tests/integration/bot/auto-nl-creation.test.ts)、[回复结果](../../../tests/integration/bot/auto-proposal-reply.test.ts)、[删除与替换](../../../tests/integration/bot/auto-nl-delete-replace.test.ts)。
- [自动任务运行](../../../tests/integration/bot/auto-agent-task-run.test.ts)、[交付 outbox](../../../tests/integration/bot/auto-delivery-outbox.test.ts)、[原身份策略测试](../../../tests/integration/bot/auto-agent-safety.test.ts)。
- [process 测试目录](../../../tests/process/)已有六种 CLI 的 opt-in 真实 smoke；执行时依本机或部署环境的真实测试指引，不能用 mock 通过代替真实验收。

代码阶段遵循项目 TDD 和 `pnpm ci:local` 门禁。文档阶段仅核验路径、链接、状态、内容与范围；本次没有运行生产服务或功能验收。

## 后续工作

本版规格是下一次拆票的依据。to-tickets 应按可观察的完整交付切片，保留真实依赖和跨模块契约；不得恢复 B01–B07 的旧执行顺序。实现授权、任务认领和代码分支安排在后续工作明确，本规格状态不等于已获准编码。
