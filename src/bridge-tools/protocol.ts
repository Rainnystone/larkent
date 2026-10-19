export const TOOL_VERSION = 1;
export const TOOL_MAX_BYTES = 256 * 1024;
export type ToolCategory = 'ok' | 'validation-failed' | 'needs-input' | 'unavailable' | 'unauthorized' | 'execution-failed';
export interface ToolResult {
  version: 1;
  category: ToolCategory;
  code: string;
  data?: unknown;
}
export function toolResult(category: ToolCategory, code: string, data?: unknown): ToolResult {
  return { version: TOOL_VERSION, category, code, ...(data === undefined ? {} : { data }) };
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export const TOOL_OPERATIONS = [
  'plugins.list', 'plugins.inspect', 'plugins.read', 'automation.schema', 'automation.list', 'automation.preview',
  'automation.create', 'automation.replace', 'automation.delete', 'automation.pause', 'automation.resume', 'automation.operation.get',
] as const;

export const TOOL_REQUEST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'operation'],
  properties: {
    version: { const: TOOL_VERSION }, operation: { enum: TOOL_OPERATIONS }, params: { type: 'object' },
  },
};
