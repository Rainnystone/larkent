/** Command representations carried by the supported runtime tool events. */
export function toolCommandInput(input: unknown): string | string[] | undefined {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec.command) && rec.command.every(part => typeof part === 'string')) return rec.command;
  if (typeof rec.command === 'string') return rec.command;
  if (typeof rec.cmd === 'string') return rec.cmd;
  return rec.rawInput !== undefined ? toolCommandInput(rec.rawInput) : undefined;
}
