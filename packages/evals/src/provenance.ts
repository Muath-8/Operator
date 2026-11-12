import { createHash } from 'node:crypto';
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}
/** Canonical JSON fingerprint: equivalent object key orders bind identically. */
export function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)) ?? 'undefined')
    .digest('hex');
}
