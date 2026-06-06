/**
 * Per-realm QBO rate limiting wrapper.
 * Re-exports the existing qboRateLimiter for cleanup-system use.
 */

import { qboRateLimiter } from "@/lib/qbo";

export async function withQboThrottle<T>(
  realmId: string,
  fn: () => Promise<T>
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  return fn();
}

export { qboRateLimiter };
