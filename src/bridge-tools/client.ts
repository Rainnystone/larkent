import { newAutomationOperationId } from '../automations/operation-id';
import { record, TOOL_MAX_BYTES, TOOL_REQUEST_SCHEMA, toolResult, type ToolResult } from './protocol';

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
// Node timers above the signed 32-bit range overflow to a 1ms timeout.
const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;

/** Local tool calls can be slower on loaded or scanned hosts; tests override this. */
function toolTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.LARK_BRIDGE_TOOL_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 && value <= MAX_TOOL_TIMEOUT_MS ? value : DEFAULT_TOOL_TIMEOUT_MS;
}

export async function requestBridgeTool(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ToolResult> {
  const endpoint = env.LARK_BRIDGE_TOOL_ENDPOINT;
  const credential = env.LARK_BRIDGE_TOOL_TOKEN;
  if (!endpoint || !credential) return toolResult('unavailable', 'no-active-run');
  const request = record(input);
  if (request && (request.params === undefined || record(request.params)) && ['automation.create', 'automation.replace', 'automation.delete', 'automation.pause', 'automation.resume'].includes(String(request?.operation))) {
    const params = record(request.params) ?? {};
    input = { ...request, params: { ...params, operationId: params.operationId ?? newAutomationOperationId(env.LARK_BRIDGE_TOOL_SCOPE ?? '', Number(env.LARK_BRIDGE_TOOL_ISSUED_AT) || Date.now()) } };
  }
  const operationId = record(record(input)?.params)?.operationId;
  const failed = (category: 'unavailable' | 'unknown' | 'execution-failed', code: string) => toolResult(operationId ? 'unknown' : category, code, operationId ? { operationId, state: 'unknown', applied: null } : undefined);
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool' || url.username || url.password || url.search || url.hash) {
      return failed('unavailable', 'invalid-run-endpoint');
    }
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(toolTimeoutMs(env)) });
    const text = await response.text();
    // The request bound protects untrusted input; legitimate stored task lists can be larger.
    if (!response.ok) return failed('execution-failed', 'invalid-tool-response');
    const result = record(JSON.parse(text));
    return result?.version === 1 && typeof result.category === 'string' && typeof result.code === 'string'
      ? result as unknown as ToolResult : failed('execution-failed', 'invalid-tool-response');
  } catch { return failed('unavailable', 'run-connection-closed'); }
}

export async function runToolCli(options: { schema?: boolean } = {}): Promise<void> {
  if (options.schema) { process.stdout.write(`${JSON.stringify(TOOL_REQUEST_SCHEMA)}\n`); return; }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let result: ToolResult;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > TOOL_MAX_BYTES) { process.stdout.write(`${JSON.stringify(toolResult('validation-failed', 'request-too-large'))}\n`); return; }
      chunks.push(buffer);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { process.stdout.write(`${JSON.stringify(toolResult('validation-failed', 'invalid-json'))}\n`); return; }
    result = await requestBridgeTool(parsed);
  } catch { result = toolResult('execution-failed', 'stdin-failed'); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
