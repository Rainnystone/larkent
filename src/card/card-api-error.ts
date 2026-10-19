export interface CardApiErrorInfo {
  code?: number;
  msg?: string;
}

/** Feishu `code` / `msg` from a cardkit or axios error, including `error.cause`. */
export function readCardApiError(err: unknown): CardApiErrorInfo {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const found = readOne(current);
    if (found) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

function readOne(error: object): CardApiErrorInfo | undefined {
  const rec = error as {
    code?: unknown;
    msg?: unknown;
    response?: { data?: { code?: unknown; msg?: unknown } };
    context?: { feishuCode?: unknown; feishuMsg?: unknown };
  };
  const data = rec.response?.data;
  if (typeof data?.code === 'number') {
    return { code: data.code, ...(typeof data.msg === 'string' ? { msg: data.msg } : {}) };
  }
  if (typeof rec.code === 'number') {
    return { code: rec.code, ...(typeof rec.msg === 'string' ? { msg: rec.msg } : {}) };
  }
  const ctx = rec.context;
  if (ctx && typeof ctx.feishuCode === 'number') {
    return {
      code: ctx.feishuCode,
      ...(typeof ctx.feishuMsg === 'string' ? { msg: ctx.feishuMsg } : {}),
    };
  }
  return undefined;
}
