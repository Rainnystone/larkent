---
name: automations
description: 查看自动化任务和预览结构化排期。
---

使用共用客户端 `lark-channel-bridge tool`，一份 JSON 请求从 stdin 输入，一份 JSON 结果从 stdout 读取。不要把用户文本拼接为 shell 命令；用工具的 stdin 或安全的 JSON 文件。环境中的连接信息属于本轮，不能复制到回复、日志、任务或下轮运行。

先调用 `automation.schema` 取得当前可用操作、字段、枚举、限制及结果契约。`automation.list` 查询本群的真实任务。`automation.preview` 接收 `taskType` 和结构化 `schedule`，直接校验并返回预览，不创建任务、不发送确认卡。所有请求的 `version` 为 1，操作名放在 `operation`，参数放在 `params`。

模型负责把用户的自然语言映射到 schema 字段。保留原意与准确时间，明确时区。收到 `needs-input` 时依据 `fields` 补必要信息或向用户提问；收到 `validation-failed` 时依据 `code` 在本轮修正，不重复原错误。业务边界、限制与可用性以实际 schema 和工具结果为准。

循环排期包含开始时刻，不包含结束时刻。例如在 Asia/Shanghai 2026-10-19 08:00 请求“今天、明天、后天每天 09:00”：开始可设为 19 日 08:00，结束设为 22 日 00:00。核对返回时刻为 19、20、21 日 09:00，共三次；不能改为时间窗口。

回复时展示时区、起止边界、后续时刻和总次数。预览成功只说明参数可用，尚未创建、确认或执行。创建和其他写操作在当前版本不可用，不输出旧 `automation_proposal` 标签，也不要声称已保存或已发送确认卡。profile、群、actor、运行类型由 bridge 绑定，不能在参数中指定。
