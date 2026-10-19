---
name: automations
description: 查询与管理任务、预览排期，创建需人工确认的提醒或 agent 自动任务。
---

使用共用客户端 `lark-channel-bridge tool`，一份 JSON 请求从 stdin 输入，一份 JSON 结果从 stdout 读取。bridge 通过 `LARK_BRIDGE_TOOL_CLIENT` 提供客户端 JS 绝对路径，无需全局安装或依赖工作目录。POSIX shell 用 `node "$LARK_BRIDGE_TOOL_CLIENT" tool`；PowerShell 用 `node "$env:LARK_BRIDGE_TOOL_CLIENT" tool`。不要把用户文本拼接为 shell 命令；用工具的 stdin 或安全的 JSON 文件。环境中的连接信息属于本轮，不能复制到回复、日志、任务或下轮运行。

先调用 `automation.schema` 取得当前可用操作、字段、枚举、限制及结果契约。`automation.list` 查询本群的真实任务。`automation.preview` 接收 `taskType` 和结构化 `schedule`，直接校验并返回预览，不创建任务、不发送确认卡。所有请求的 `version` 为 1，操作名放在 `operation`，参数放在 `params`。

模型负责把用户的自然语言映射到 schema 字段。保留原意与准确时间，明确时区。收到 `needs-input` 时依据 `fields` 补必要信息或向用户提问；收到 `validation-failed` 时依据 `code` 在本轮修正，不重复原错误。业务边界、限制与可用性以实际 schema 和工具结果为准。

循环排期包含开始时刻，不包含结束时刻。例如在 Asia/Shanghai 2026-10-19 08:00 请求“今天、明天、后天每天 09:00”：开始可设为 19 日 08:00，结束设为 22 日 00:00。核对返回时刻为 19、20、21 日 09:00，共三次；不能改为时间窗口。

回复时展示时区、起止边界、后续时刻和总次数。预览成功只说明参数可用，尚未创建、确认或执行。创建任务使用 `automation.create`（taskType:reminder 或 agent、name、taskText、schedule，可带 timezone）。reminder 到期投递正文；agent 到期在创建时绑定的工作目录运行，按需读取插件并使用所属 profile 已授权的 bot/user 身份，创建者不自动成为 OAuth 用户。agentTasks 开关、工作目录和当前群/话题条件以实际工具结果为准。客户端在发送前确定 operationId，并在结果中返回；重试必须保留原编号和同一语义参数。可在客户端本地先生成编号并保存：`op1.<环境 LARK_BRIDGE_TOOL_SCOPE>.<环境 LARK_BRIDGE_TOOL_ISSUED_AT>.<32 位随机十六进制>`。提交有效期 24 小时，过期编号不能重用；回执可跨 run、重启查询。参数错误修正改变含义时使用新编号。超时、断线或 unknown 先调用 `automation.operation.get`（params.operationId）；禁止盲目重发或换编号重建。unknown 表示结果不明，不能声称失败后自动重建。

`needs-input/missing-end-at` 可包含已发送的结束时间补全卡；用户补全后仍须点击确认卡。只有 `waiting-confirmation` 且有真实卡片回执时才能说等待确认；`applied` 表示操作已经实际生效；创建、替换和删除需先由用户确认，暂停与恢复立即应用。未来执行与结果送达另看实际状态：operation.get 的 executionState/lastExecution 表示排队、运行及实际运行结果，lastDelivery/deliveredCount 表示独立的交付状态；失败通知送达不代表任务执行成功，运行失败也不表示创建失败。空输出按实际空结果交付；交付待恢复时不重跑业务。dispatch 不等于送达。人工确认不是模型能力，不能用工具或 shell 代点。agent 任务仅在 schema 明确可用时创建。自动运行可以发现和读取插件完成业务，但不能递归创建、替换、删除、暂停或恢复调度，不能借 shell 或人工旧凭据绕过运行类型校验。仅通过工具请求操作，依据实际回执说明保存与确认卡状态。profile、群、actor、运行类型由 bridge 绑定，不能在参数中指定。

管理既有提醒和 agent 任务时，先用 `automation.list` 核对本群当前目标及其状态，并把返回的 `revision` 连同 `id` 提交；不要凭旧对话编号推断目标仍然有效。`automation.pause`、`automation.resume` 直接应用；按实际结果回复，排期结束、目标不存在或状态变化时按具体代码处理。`automation.delete` 发送人工删除确认卡；`automation.replace` 提交 id、revision、taskType、name、taskText、结构化 schedule（与创建相同的排期校验及预览），由用户确认后替换。替换缺少结束时间时沿用补全卡；确认前原任务保持有效。上述写操作都使用同一 operationId、去重和结果查询契约。状态冲突后重新查询并根据用户原意发起新操作，不代替用户确认，也不自动重建已删除的目标。
