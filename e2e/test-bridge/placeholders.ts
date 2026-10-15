/** Angle-bracket tokens used only in the committed example config. */
export const PLACEHOLDER = /<[A-Z][A-Z0-9_]+>/;

export function findPlaceholders(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return PLACEHOLDER.test(value) ? [path || '(root)'] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      findPlaceholders(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}
