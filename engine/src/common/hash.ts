import { createHash } from 'node:crypto';
import { contentHash, type ContentHash } from './ids.ts';

export function sha256(data: string | Uint8Array): ContentHash {
  return contentHash(createHash('sha256').update(data).digest('hex'));
}

/** Canonical JSON: object keys sorted, no whitespace. Used for payload hashes and ids. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    // A prototype-less object, so keys such as "__proto__" stay ordinary data.
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) Object.defineProperty(out, k, { value: sortKeys(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

export function hashJson(value: unknown): ContentHash {
  return sha256(canonicalJson(value));
}
