/** Shared protocol value readers; parsers retain their native empty/finite rules. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function truncate(value: string, max: number): string { return value.slice(0, max); }
