import { Readable, Writable } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { ClientApp, ndJsonStream, type ClientConnection, type PromptResponse } from '@agentclientprotocol/sdk';
import { spawnProcess } from '../../platform/spawn';
import { readProcessStartMs } from '../../platform/process-info';
import { signalProcessTree, killSurvivingOutOfGroupDescendants, waitForProcessGroupExit } from '../../platform/process-tree';
import { RunCleanupFailed } from '../../runtime/errors';
import { log } from '../../core/logger';
import { BoundedStderr } from '../runner/bounded-stderr';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { configureDevinSession, type DevinRunConfig } from './acp-config';
import { buildDevinArgs } from './argv';
import { DevinTranscriptTranslator } from './transcript';

export function runDevinAcp(input: {
  binary: string; options: AgentRunOptions; prompt: string; env: NodeJS.ProcessEnv; config: DevinRunConfig; stopGraceMs: number;
}): AgentRun {
  const { options, config, stopGraceMs } = input;
  const child = spawnProcess(input.binary, buildDevinArgs(config), { cwd: options.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Devin ACP requires piped stdio');
  const stdin = child.stdin, stdout = child.stdout;
  const startedAt = child.pid ? readProcessStartMs(child.pid) ?? Date.now() : undefined;
  const stderr = new BoundedStderr();
  let stderrLine = '';
  const flushStderr = () => { if (stderrLine.trim()) log.warn('agent', 'stderr', { line: stderrLine }); stderrLine = ''; };
  child.stderr.on('data', (b: Buffer) => {
    stderr.push(b);
    stderrLine = (stderrLine + b.toString('utf8')).slice(-64 * 1024);
    const lines = stderrLine.split('\n'); stderrLine = lines.pop()!;
    for (const line of lines) if (line.trim()) log.warn('agent', 'stderr', { line });
  });
  child.stderr.on('end', flushStderr).on('close', flushStderr);
  // Stream errors also reject the SDK request. An error listener prevents EPIPE
  // from becoming an uncaught exception while cancellation closes the transport.
  stdin.on('error', () => {});
  let processError: Error | undefined;
  child.on('error', e => { processError = e; });
  let exited = false;
  let exit: number | null = null;
  let signal: string | null = null;
  const noteExit = (code: number | null, sig: string | null) => { exited = true; exit = code; signal = sig; };
  child.once('exit', noteExit);
  const closed = new Promise<void>(resolve => {
    child.once('close', (code, sig) => { noteExit(code, sig); resolve(); });
  });
  const translator = new DevinTranscriptTranslator();
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let stopping = false;
  let cleanupError: unknown;
  let sessionId: string | undefined;
  let prompting = false;
  let blocked = false;
  let connection: ClientConnection;
  let shutdownPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let termSent = false;
  const push = (events: Iterable<AgentEvent>) => { queue.push(...events); const notify = wake; wake = undefined; notify?.(); };
  const app = new ClientApp({ name: 'larkent-devin' });
  app.onNotification('session/update', ({ params }) => {
    if (params.sessionId !== sessionId || !prompting || stopping) return;
    push(translator.translate(params.update));
    if (translator.terminalEmitted()) connection.close(new Error('Invalid Devin tool update'));
  });
  app.onRequest('session/request_permission', ({ params }) => {
    if (stopping) return { outcome: { outcome: 'cancelled' } };
    blocked = true;
    const reject = params.options.find(o => o.kind === 'reject_once') ?? params.options.find(o => o.kind === 'reject_always');
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
  });
  connection = app.connect(ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout).pipeThrough(strictJsonLines()), { maxMessageBytes: 8 * 1024 * 1024 }));

  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    connection.close();
    stdin.end();
    if (!termSent) {
      if (await within(closed, stopGraceMs) && !stopping) return;
      signalProcessTree(child, 'SIGTERM', true);
      termSent = true;
    }
    const graceUntil = Date.now() + stopGraceMs;
    const closedInGrace = await within(closed, stopGraceMs);
    if (stopping) {
      // Leader exit does not prove its independent-stdio tools stopped. Keep
      // the existing grace, then kill/confirm remaining group members too.
      const groupExited = await waitForProcessGroupExit(child, graceUntil - Date.now());
      if (!closedInGrace || !groupExited) signalProcessTree(child, 'SIGKILL', true);
      const [leaderClosed, groupClosed] = await Promise.all([
        within(closed, 5000),
        waitForProcessGroupExit(child, 5000),
        killSurvivingOutOfGroupDescendants(child, 0),
      ]);
      if (!leaderClosed || !groupClosed) throw new RunCleanupFailed('Devin process tree did not exit after cancellation');
      return;
    }
    if (closedInGrace) {
      await killSurvivingOutOfGroupDescendants(child, 0);
      return;
    }
    signalProcessTree(child, 'SIGKILL', true);
    await killSurvivingOutOfGroupDescendants(child, 0);
    // Same cleanup bound as the existing JSONL runner. Never report settlement
    // while the process or its inherited pipes are still alive.
    if (!await within(closed, 5000)) throw new RunCleanupFailed('Devin process did not exit after SIGKILL');
  })();

  const settlement = (async () => {
    let terminal: AgentEvent[] = [];
    try {
      const initialized = await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'larkent', version: '0.8.0' } });
      if (initialized.protocolVersion !== 1) throw new Error('Unsupported Devin ACP protocol version');
      if (stopping) throw new Error('Devin cancelled');
      if (options.resumeHandle && !initialized.agentCapabilities?.loadSession) throw new Error('Devin does not support session loading');
      const state = options.resumeHandle
        ? await connection.agent.request('session/load', { sessionId: options.resumeHandle, cwd: options.cwd!, mcpServers: [] })
        : await connection.agent.request('session/new', { cwd: options.cwd!, mcpServers: [] });
      sessionId = 'sessionId' in state ? state.sessionId as string : options.resumeHandle;
      if (!sessionId) throw new Error('Devin did not return a session handle');
      await configureDevinSession(connection.agent, sessionId, state, config, options.model);
      if (stopping) throw new Error('Devin cancelled');
      push([{ type: 'system', resumeHandle: sessionId, cwd: options.cwd, model: options.model }]);
      prompting = true;
      const result = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] });
      if (blocked) throw new Error('Devin permission request rejected; execution was blocked');
      // Native Devin extends the stable ACP prompt response with token usage.
      const usage = (result as PromptResponse & { usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number } }).usage;
      if (usage) push([{ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedReadTokens }]);
      terminal = translator.finish(stopping ? 'cancelled' : result.stopReason);
    } catch (error) {
      terminal = stopping ? translator.finish('cancelled') : translator.fail(error);
    } finally {
      prompting = false;
      try { await shutdown(); }
      catch (error) { cleanupError = error; }
      if (!stopping && (processError || (exit !== null && exit !== 0))) {
        // Error detail retains the tail too, where transport signatures often occur.
        terminal = [{ type: 'error', terminationReason: 'failed', message: `Devin ${processError?.message ?? `exited with code ${exit}`}: ${stderr.snapshot().slice(-4096)}` }];
      }
      if (stopping && terminal.length === 0) terminal = translator.finish('cancelled');
      push(terminal.map(e => e.type === 'done' ? { ...e, resumeHandle: sessionId } : e));
      finished = true; wake?.(); wake = undefined;
    }
    if (cleanupError) throw cleanupError;
  })();
  void settlement.catch(() => {});

  const stop = (): Promise<void> => stopPromise ??= (async () => {
    if (!finished) {
      stopping = true;
      if (sessionId && prompting) await within(connection.agent.notify('session/cancel', { sessionId }), stopGraceMs).catch(() => false);
      // Snapshot/signal descendants before EOF can reparent them. The leader
      // may exit on EOF while a shell child with independent stdio stays alive.
      signalProcessTree(child, 'SIGTERM', true);
      termSent = true;
      await shutdown();
    }
    await settlement;
  })();
  const generator = (async function* () {
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished) { if (cleanupError) throw cleanupError; return; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally { if (!finished) await stop(); }
  })();
  return {
    runId: options.runId, pid: child.pid, startedAt,
    get stderrSnapshot() { return stderr.snapshot(); },
    get exit() { return exited ? exit : undefined; },
    get signal() { return exited ? signal : undefined; },
    events: { [Symbol.asyncIterator]() { return { next: () => generator.next(), return: async () => { await stop(); return generator.return(undefined); } }; } },
    stop,
    waitForExit: timeoutMs => within(settlement, timeoutMs),
  };
}

async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** The SDK tolerates parse errors; a bridge run must surface a broken peer. */
function strictJsonLines(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) if (line.trim()) validateMessage(JSON.parse(line));
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) throw new Error('Devin ACP message exceeded 8 MiB');
      controller.enqueue(chunk);
    },
    flush() { pending += decoder.decode(); if (pending.trim()) validateMessage(JSON.parse(pending)); },
  });
}

function validateMessage(message: unknown): void {
  if (!message || typeof message !== 'object' || !('jsonrpc' in message) || message.jsonrpc !== '2.0') throw new Error('Invalid Devin ACP message');
  if (!('method' in message) || message.method !== 'session/update') return;
  const params = 'params' in message ? message.params : undefined;
  if (!params || typeof params !== 'object' || !('sessionId' in params) || typeof params.sessionId !== 'string' || !('update' in params)) throw new Error('Invalid Devin session notification');
  const u = params.update;
  if (!u || typeof u !== 'object' || !('sessionUpdate' in u) || typeof u.sessionUpdate !== 'string') throw new Error('Invalid Devin session update');
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
    if (!('toolCallId' in u) || typeof u.toolCallId !== 'string' || !u.toolCallId) throw new Error('Invalid Devin toolCallId');
    if (u.sessionUpdate === 'tool_call' && (!('title' in u) || typeof u.title !== 'string')) throw new Error('Invalid Devin tool title');
  }
  if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
    const c = 'content' in u ? u.content : undefined;
    if (!c || typeof c !== 'object' || !('type' in c) || (c.type === 'text' && (!('text' in c) || typeof c.text !== 'string'))) throw new Error('Invalid Devin content chunk');
  }
}
