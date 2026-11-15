import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compare a SHA-256 hex digest without leaking byte-by-byte timing information.
 * Invalid encodings and wrong-length values are rejected before comparison.
 */
export function safeHexEqual(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected) || !/^[a-f0-9]{64}$/i.test(received)) {
    return false;
  }
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(received, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}
