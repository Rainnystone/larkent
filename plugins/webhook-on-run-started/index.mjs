/**
 * Opt-in telemetry adapter. Point `LARK_CHANNEL_TELEMETRY_MODULE` at this file
 * to POST one versioned `run.started` JSON object to an operator webhook.
 *
 * Env (placeholders only in docs/tests — never a real URL or key in the repo):
 *   LARK_RUN_STARTED_WEBHOOK_URL          required to activate
 *   LARK_RUN_STARTED_WEBHOOK_KEY          optional; sent as Bearer + X-Automation-Key
 *   LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS   optional, default 4000, clamped 3000–5000
 *   LARK_RUN_STARTED_BOT_NAME             optional; falls back to adapter meta.appId
 */

const DEFAULT_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 5000;

function clampTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function warnFailure(fields) {
  // Status / error class only — never URL, key, headers, or query string.
  console.warn(`⚠ [run-started-webhook] failed ${JSON.stringify(fields)}`);
}

function warnCaught(err) {
  warnFailure({ err: err instanceof Error ? err.name : 'Error' });
}

function buildPayload(event, bot) {
  const fields = event?.fields ?? {};
  const ctx = event?.ctx ?? {};
  const runId = stringOrNull(fields.runId);
  const taskKey = stringOrNull(fields.taskKey);
  return {
    v: 1,
    type: 'run.started',
    key: taskKey ?? runId,
    task_key: taskKey,
    bot,
    scope: stringOrNull(fields.scope),
    chat_id: stringOrNull(ctx.chatId) ?? stringOrNull(fields.chatId),
    thread_id: stringOrNull(fields.threadId) ?? stringOrNull(ctx.threadId),
    message_id:
      stringOrNull(ctx.msgId)
      ?? stringOrNull(fields.messageId)
      ?? stringOrNull(fields.msgId),
    run_id: runId,
    agent: stringOrNull(fields.agent),
    ts: stringOrNull(event?.ts),
  };
}

export function createAdapter(meta = {}) {
  const url = typeof process.env.LARK_RUN_STARTED_WEBHOOK_URL === 'string'
    ? process.env.LARK_RUN_STARTED_WEBHOOK_URL.trim()
    : '';
  const configuredKey = typeof process.env.LARK_RUN_STARTED_WEBHOOK_KEY === 'string'
    ? process.env.LARK_RUN_STARTED_WEBHOOK_KEY
    : '';
  const bot = stringOrNull(process.env.LARK_RUN_STARTED_BOT_NAME) ?? stringOrNull(meta.appId);
  const timeoutMs = clampTimeoutMs(process.env.LARK_RUN_STARTED_WEBHOOK_TIMEOUT_MS);
  const inFlight = new Set();
  const closeController = new AbortController();
  let closed = false;

  const noop = {
    emit() {},
    recordError() {},
    recordMetric() {},
    async flush() {},
    close() {},
  };
  if (!url) return noop;

  function emit(event) {
    if (closed) return;
    try {
      if (event?.phase !== 'run' || event?.event !== 'started') return;
      const payload = buildPayload(event, bot);
      const headers = { 'content-type': 'application/json' };
      if (configuredKey) {
        headers.authorization = `Bearer ${configuredKey}`;
        headers['x-automation-key'] = configuredKey;
      }
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), closeController.signal]);
      const pending = (async () => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal,
          });
          if (!res.ok) warnFailure({ status: res.status });
        } catch (err) {
          warnCaught(err);
        }
      })();
      inFlight.add(pending);
      void pending.finally(() => inFlight.delete(pending));
    } catch (err) {
      warnCaught(err);
    }
  }

  async function flush(timeoutMsBound) {
    const pending = Promise.allSettled([...inFlight]);
    if (timeoutMsBound === undefined) {
      await pending;
      return;
    }
    await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(resolve, timeoutMsBound)),
    ]);
  }

  function close() {
    closed = true;
    if (!closeController.signal.aborted) closeController.abort();
  }

  return {
    emit,
    recordError() {},
    recordMetric() {},
    flush,
    close,
  };
}

export default createAdapter;
