export const AUTOMATIONS_SCHEMA_VERSION = 2 as const;

/** Pure forward upgrade. Existing tasks, drafts and card registrations retain their meaning. */
export function upgradeAutomationsDocument(raw: unknown): { current: Record<string, unknown>; upgraded: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid automations document: expected object');
  const document = raw as Record<string, unknown>;
  if (document.schemaVersion === 1) return { current: { ...document, schemaVersion: AUTOMATIONS_SCHEMA_VERSION, operations: [] }, upgraded: true };
  if (document.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION) throw new Error(`Unsupported automations schemaVersion: ${String(document.schemaVersion)}`);
  return { current: document, upgraded: false };
}
