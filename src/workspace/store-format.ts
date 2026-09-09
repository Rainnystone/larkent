export interface WorkspaceDocumentV2 {
  schemaVersion: 2;
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function upgradeWorkspaceDocument(raw: unknown): { document: WorkspaceDocumentV2; upgraded: boolean } {
  if (!isMap(raw)) throw new Error('Invalid workspace document: expected object');
  const upgraded = !Object.hasOwn(raw, 'schemaVersion');
  if (!upgraded && raw.schemaVersion !== 2) {
    throw new Error(`Unsupported workspace schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const chats = upgraded && !Object.hasOwn(raw, 'chats') ? {} : raw.chats;
  const named = upgraded && !Object.hasOwn(raw, 'named') ? {} : raw.named;
  if (!isMap(chats) || !isMap(named)) throw new Error('Invalid workspace maps: expected objects');
  const chatEntries: Array<[string, { cwd: string }]> = [];
  const namedEntries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(chats)) {
    if (!isMap(value) || !Object.hasOwn(value, 'cwd') || typeof value.cwd !== 'string') {
      if (upgraded) continue;
      throw new Error(`Invalid workspace chat: ${key}`);
    }
    chatEntries.push([key, { cwd: value.cwd }]);
  }
  for (const [key, value] of Object.entries(named)) {
    if (typeof value !== 'string') {
      if (upgraded) continue;
      throw new Error(`Invalid workspace alias: ${key}`);
    }
    namedEntries.push([key, value]);
  }
  return { document: { schemaVersion: 2, chats: Object.fromEntries(chatEntries), named: Object.fromEntries(namedEntries) }, upgraded };
}
