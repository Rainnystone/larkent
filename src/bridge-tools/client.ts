import { record, TOOL_MAX_BYTES, TOOL_REQUEST_SCHEMA, toolResult, type ToolResult } from './protocol';

export async function requestBridgeTool(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ToolResult> {
  const endpoint = env.LARK_BRIDGE_TOOL_ENDPOINT;
  const credential = env.LARK_BRIDGE_TOOL_TOKEN;
  if (!endpoint || !credential) return toolResult('unavailable', 'no-active-run');
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool' || url.username || url.password || url.search || url.hash) {
      return toolResult('unavailable', 'invalid-run-endpoint');
    }
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    // The request bound protects untrusted input; legitimate stored task lists can be larger.
    if (!response.ok) return toolResult('execution-failed', 'invalid-tool-response');
    const result = record(JSON.parse(text));
    return result?.version === 1 && typeof result.category === 'string' && typeof result.code === 'string'
      ? result as unknown as ToolResult : toolResult('execution-failed', 'invalid-tool-response');
  } catch { return toolResult('unavailable', 'run-connection-closed'); }
}

export async function runToolCli(options: { schema?: boolean } = {}): Promise<void> {
  if (options.schema) { process.stdout.write(`${JSON.stringify(TOOL_REQUEST_SCHEMA)}\n`); return; }
  let input = '';
  let result: ToolResult;
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > TOOL_MAX_BYTES) { process.stdout.write(`${JSON.stringify(toolResult('validation-failed', 'request-too-large'))}\n`); return; }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input); }
    catch { process.stdout.write(`${JSON.stringify(toolResult('validation-failed', 'invalid-json'))}\n`); return; }
    result = await requestBridgeTool(parsed);
  } catch { result = toolResult('execution-failed', 'stdin-failed'); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
