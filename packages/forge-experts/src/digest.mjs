/**
 * Shared canonical digest helper for @heluo/forge-experts.
 *
 * Canonicalization rule: object keys are sorted lexicographically (UTF-16 code unit order)
 * at every plain-object level before JSON serialization, arrays preserve order, and the
 * UTF-8 JSON bytes are hashed with SHA-256 (`sha256:<hex>`).
 */
import { createHash } from 'node:crypto';

function canonicalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function computeCanonicalDigest(fields) {
  const canonical = JSON.stringify(canonicalizeValue(fields));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
