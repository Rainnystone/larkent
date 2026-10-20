import { automationToolAvailability } from '../automations/tools';
import type { ToolRunContext } from './server';

/** Shared discovery contract; skill bodies remain available only through the client. */
export async function bridgeToolInstructions(context: ToolRunContext): Promise<string[]> {
  return [
    'Bridge plugins：共用入口为 lark-channel-bridge tool；客户端 JS 绝对路径在环境 LARK_BRIDGE_TOOL_CLIENT，用 node <该路径> tool 调用，按当前 shell 安全引用路径。' +
    '从 stdin 发送版本化 JSON（version:1, operation, params），stdout 是本轮实际工具结果。' +
    '按需 plugins.list、plugins.inspect（params.plugin）、plugins.read（params.skill）；唯一的插件/skill 名或别名可直达，歧义时选择候选 ID 并原样回传其 reference 为 params.reference，同 ID 包仅靠 canonical 名无法消歧。' +
    '资源读取使用 plugins.read 的 params.resource（包内路径）和 params.reference（读取结果的版本引用）；脚本按返回路径用 runtime 现有工具执行，遵守当前访问模式。旧引用失效需重新发现。' +
    '根据结果在本轮补字段或修正；最终回复由你负责。连接由环境提供，不得展示或保存运行凭据。创建任务须以实际工具回执为准，人工确认后生效；其他变更按 schema 可用性处理。',
    `<bridge_plugins>${JSON.stringify({ plugins: await context.catalog.list(), diagnostics: context.catalog.diagnostics })}</bridge_plugins>`,
    `<bridge_run>${JSON.stringify({ profile: context.profile, chatId: context.chatId, actorId: context.actorId, runType: context.runType, now: (context.now ?? Date.now)(), timezone: context.timezone, agentTasks: context.agentTasks, cwd: context.cwd, automationUnavailable: automationToolAvailability(context) ?? null })}</bridge_run>`,
  ];
}
