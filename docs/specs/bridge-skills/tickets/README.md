# PR51 tickets — Revision 2.1 已被替代

Status: superseded · 2026-10-19

当前依据是 [Revision 3 规格](../../bridge-skills.md)和[交接入口](../HANDOFF.md)。用户已确认先完整交付插件机制与 automation；本轮完成 to-spec，尚未执行新的 to-tickets。

**B01–B07 均不能认领或实施。** 各文件保留旧票内容用于追溯，文件顶部的 superseded 状态优先于正文旧验收和执行说明。需要从 Revision 3 重新切分工作包，不能仅将旧票改名后继续。

| 旧票 | 当前状态 | 后续处理依据 |
| --- | --- | --- |
| [B01](B01-skill-module-and-automations.md) | superseded | 按 plugin 管理、逐层发现及 automation 正常调用重新切片。 |
| [B02](B02-rejection-feedback.md) | superseded | 下一轮注入拒绝反馈改为本轮工具结果，旧队列方案不继续。 |
| [B03](B03-no-card-promise-on-rejection.md) | superseded | 真实状态回执和副作用一致性承担正确性，措辞只负责解释。 |
| [B04](B04-lark-cli-skills.md) | superseded / 原业务迁移延期 | 本次只包含 automation 所需共用基础和身份修正。 |
| [B05](B05-interactive-card-skill.md) | superseded / 延期 | 通用交互卡片说明迁移不在本次范围。 |
| [B06](B06-comment-and-meeting-skills.md) | superseded / 延期 | 评论和会议说明迁移不在本次范围。 |
| [B07](B07-e2e-three-clis.md) | superseded | 按新调用链、真实业务结果和六种 CLI 重新定义验收。 |

新票应包含本票可独立验收的结果、真实 blocking edges、必要接口和测试；实施继续遵循项目规则与本版规格。当前没有新的 ready-for-agent 实现票。
