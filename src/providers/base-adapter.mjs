import crypto from 'node:crypto';

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Fails safely if buffer lengths differ.
 * @param {string | undefined | null} a
 * @param {string | undefined | null} b
 * @returns {boolean} True if strings are identical.
 */
export function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Length-prefixes an arbitrary string component to prevent delimiter collision attacks:
 * Part(s) = len(s) + ":" + s
 * @param {any} value
 * @returns {string}
 */
export function encodePart(value) {
  if (value === null || value === undefined) {
    return '0:';
  }
  const str = String(value);
  return `${Buffer.byteLength(str, 'utf8')}:${str}`;
}
