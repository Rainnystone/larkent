import { automationOperationScope } from '../automations/operation-id';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { callAutomationTool, automationSchema, type AutomationToolContext } from '../automations/tools';
import type { PluginCatalog } from '../plugins/catalog';
import { bridgePackageRoot } from '../platform/package-root';
import { record, TOOL_MAX_BYTES, TOOL_OPERATIONS, toolResult, type ToolResult } from './protocol';

export interface ToolRunContext extends AutomationToolContext {
  catalog: PluginCatalog;
  onResult?(result: ToolResult): void;
}
export interface ToolRun {
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

const LOOPBACK_BIND_ATTEMPTS = 5;
const TRANSIENT_BIND_CODES = new Set(['EADDRINUSE', 'EAGAIN', 'EMFILE', 'ENFILE']);

function isTransientBindError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_BIND_CODES.has(code);
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      server.off('error', onError);
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    server.once('error', onError);
    try {
      server.listen(0, '127.0.0.1', () => finish());
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function closeServerQuietly(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.closeAllConnections();
    } catch {
      /* not listening */
    }
    server.close(() => resolve());
  });
}

/** One opaque credential authorizes one bound run. Never shares supervisor authority. */
export async function openToolRun(context: ToolRunContext): Promise<ToolRun> {
  const client = join(await bridgePackageRoot(), 'bin/lark-channel-bridge.mjs');
  const credential = randomBytes(32).toString('base64url');
  let active = true;
  let closing: Promise<void> | undefined;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('content-type', 'application/json');
    const reply = (result: ToolResult) => { response.end(`${JSON.stringify(result)}\n`); };
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${credential}`);
    if (!active || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      reply(toolResult('unauthorized', 'invalid-run-credential')); return;
    }
    if (request.method !== 'POST' || request.url !== '/tool') { reply(toolResult('validation-failed', 'invalid-endpoint')); return; }
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
      const result = await dispatch(value, context);
      context.onResult?.(result);
      reply(result);
    } catch { reply(toolResult('execution-failed', 'tool-failed')); }
  };

  let server: Server | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < LOOPBACK_BIND_ATTEMPTS; attempt++) {
    const candidate = createServer(handleRequest);
    candidate.requestTimeout = 10_000;
    candidate.headersTimeout = 10_000;
    try {
      await listenLoopback(candidate);
      server = candidate;
      break;
    } catch (error) {
      lastError = error;
      await closeServerQuietly(candidate);
      if (!isTransientBindError(error) || attempt === LOOPBACK_BIND_ATTEMPTS - 1) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (!server) throw lastError instanceof Error ? lastError : new Error('loopback bind failed');
  server.unref();
  const port = (server.address() as AddressInfo).port;
  const bound = server;
  return {
    env: { LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${port}/tool`, LARK_BRIDGE_TOOL_TOKEN: credential, LARK_BRIDGE_TOOL_ISSUED_AT: String((context.now ?? Date.now)()), LARK_BRIDGE_TOOL_SCOPE: automationOperationScope(context.profile, context.chatId), LARK_BRIDGE_TOOL_CLIENT: client },
    close() {
      active = false;
      closing ??= new Promise<void>((resolve, reject) => {
        bound.closeAllConnections();
        bound.close(error => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}

async function dispatch(value: unknown, context: ToolRunContext): Promise<ToolResult> {
  const request = record(value);
  if (!request || request.version !== 1) return toolResult('validation-failed', 'unsupported-version');
  if (Object.keys(request).some(key => !['version', 'operation', 'params'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (typeof request.operation !== 'string' || !(TOOL_OPERATIONS as readonly string[]).includes(request.operation)) return toolResult('unavailable', 'unknown-operation');
  const params = request.params === undefined ? {} : record(request.params);
  if (!params) return toolResult('validation-failed', 'invalid-params');
  switch (request.operation) {
    case 'plugins.list':
      if (Object.keys(params).length) return toolResult('validation-failed', 'unknown-field');
      return toolResult('ok', 'plugins', { plugins: await context.catalog.list(), diagnostics: context.catalog.diagnostics });
    case 'plugins.inspect': {
      if (Object.keys(params).some(key => !['plugin', 'reference'].includes(key))) return toolResult('validation-failed', 'unknown-field');
      if (typeof params.plugin !== 'string' || !params.plugin || params.reference !== undefined && typeof params.reference !== 'string') return toolResult('validation-failed', 'invalid-params');
      const result = await context.catalog.resolveInspect(params.plugin, { reference: params.reference as string | undefined });
      const plugin = record(result.data);
      const automationContext = plugin?.id === 'automation' && !await context.catalog.isAvailable('automation')
        ? { ...context, availability: () => 'automation-plugin-unavailable' } : context;
      return result.code === 'plugin' && plugin
        ? toolResult('ok', 'plugin', { ...plugin, ...(plugin.id === 'automation' ? { capabilities: automationSchema(automationContext).operations } : {}) })
        : toolResult('unavailable', result.code, result.data);
    }
    case 'plugins.read': {
      if (Object.keys(params).some(key => !['skill', 'resource', 'reference'].includes(key))) return toolResult('validation-failed', 'unknown-field');
      if (typeof params.skill !== 'string' || !params.skill || ['resource', 'reference'].some(key => params[key] !== undefined && typeof params[key] !== 'string')) return toolResult('validation-failed', 'invalid-params');
      const result = await context.catalog.resolveRead(params.skill, { resource: params.resource as string | undefined, reference: params.reference as string | undefined });
      return toolResult(['content', 'plugin'].includes(result.code) ? 'ok' : 'unavailable', result.code, result.data);
    }
    default:
      if (!await context.catalog.isAvailable('automation')) return toolResult('unavailable', 'automation-plugin-unavailable');
      return callAutomationTool(request.operation, params, context);
  }
}
