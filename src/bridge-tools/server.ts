import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { callAutomationTool, automationSchema, type AutomationToolContext } from '../automations/tools';
import type { PluginCatalog } from '../plugins/catalog';
import { bridgePackageRoot } from '../platform/package-root';
import { record, TOOL_MAX_BYTES, TOOL_OPERATIONS, toolResult, type ToolResult } from './protocol';

export interface ToolRunContext extends AutomationToolContext { catalog: PluginCatalog }
export interface ToolRun {
  env: NodeJS.ProcessEnv;
  used(): boolean;
  close(): Promise<void>;
}

/** One opaque credential authorizes one bound run. Never shares supervisor authority. */
export async function openToolRun(context: ToolRunContext): Promise<ToolRun> {
  const client = join(await bridgePackageRoot(), 'bin/lark-channel-bridge.mjs');
  const credential = randomBytes(32).toString('base64url');
  let active = true;
  let used = false;
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const reply = (result: ToolResult) => { response.end(`${JSON.stringify(result)}\n`); };
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${credential}`);
    if (!active || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      reply(toolResult('unauthorized', 'invalid-run-credential')); return;
    }
    if (request.method !== 'POST' || request.url !== '/tool') { reply(toolResult('validation-failed', 'invalid-endpoint')); return; }
    used = true;
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > TOOL_MAX_BYTES) { reply(toolResult('validation-failed', 'request-too-large')); return; }
        chunks.push(Buffer.from(chunk));
      }
      if (!active) { reply(toolResult('unauthorized', 'run-revoked')); return; }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(toolResult('validation-failed', 'invalid-json')); return; }
      reply(dispatch(value, context));
    } catch { reply(toolResult('execution-failed', 'tool-failed')); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    env: { LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${port}/tool`, LARK_BRIDGE_TOOL_TOKEN: credential, LARK_BRIDGE_TOOL_CLIENT: client },
    used: () => used,
    close() {
      active = false;
      closing ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}

function dispatch(value: unknown, context: ToolRunContext): ToolResult {
  const request = record(value);
  if (!request || request.version !== 1) return toolResult('validation-failed', 'unsupported-version');
  if (Object.keys(request).some(key => !['version', 'operation', 'params'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (typeof request.operation !== 'string' || !(TOOL_OPERATIONS as readonly string[]).includes(request.operation)) return toolResult('unavailable', 'unknown-operation');
  const params = request.params === undefined ? {} : record(request.params);
  if (!params) return toolResult('validation-failed', 'invalid-params');
  switch (request.operation) {
    case 'plugins.list':
      if (Object.keys(params).length) return toolResult('validation-failed', 'unknown-field');
      return toolResult('ok', 'plugins', { plugins: context.catalog.list(), diagnostics: context.catalog.diagnostics });
    case 'plugins.inspect': {
      if (Object.keys(params).some(key => key !== 'plugin')) return toolResult('validation-failed', 'unknown-field');
      const plugin = typeof params.plugin === 'string' ? context.catalog.inspect(params.plugin) : undefined;
      return plugin ? toolResult('ok', 'plugin', { ...plugin, ...(plugin.id === 'automation' ? { capabilities: automationSchema(context).operations } : {}) }) : toolResult('unavailable', 'plugin-not-found');
    }
    case 'plugins.read': {
      if (Object.keys(params).some(key => key !== 'skill')) return toolResult('validation-failed', 'unknown-field');
      const content = typeof params.skill === 'string' ? context.catalog.read(params.skill) : undefined;
      return content ? toolResult('ok', 'content', content) : toolResult('unavailable', 'skill-not-found-or-ambiguous');
    }
    default:
      if (!context.catalog.inspect('automation')) return toolResult('unavailable', 'automation-plugin-unavailable');
      return callAutomationTool(request.operation, params, context);
  }
}
