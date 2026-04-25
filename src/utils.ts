export function toSnakeCasePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCasePayload);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    out[snake] = toSnakeCasePayload(item);
  }
  return out;
}

export function joinUrl(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .join('/');
}

export function parseJsonOption<T = unknown>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== '')) as Partial<T>;
}
