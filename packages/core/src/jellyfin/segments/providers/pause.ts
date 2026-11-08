import { Cache } from '../../../utils/cache.js';

/** Seconds from now: a delta, or an epoch time in seconds. */
export function resetIn(value: string | null): number | undefined {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e9 ? n - Date.now() / 1000 : n;
}

/** When a 429 names no reset. */
export const DEFAULT_PAUSE_S = 60;
export const MAX_PAUSE_S = 86_400;

/** A 429's `Retry-After`, else a minute. */
export function retryAfter(headers: Headers): number {
  const seconds = resetIn(headers.get('retry-after'));
  return Math.min(
    Math.ceil(seconds && seconds > 0 ? seconds : DEFAULT_PAUSE_S),
    MAX_PAUSE_S
  );
}

/*
 * A rate-limited provider answers 429 again for every lookup until its window
 * resets, so after one nothing is sent until then. In the shared cache so
 * every replica waits.
 */
export function providerPause(cacheName: string, providerName: string) {
  const until = Cache.getInstance<string, number>(cacheName, 1_000);
  return {
    /** Throws while `key` is paused, so the lookup is not remembered as a miss. */
    async check(key: string): Promise<void> {
      const at = await until.get(key).catch(() => undefined);
      if (at && at > Date.now())
        throw new Error(
          `${providerName} is rate limited, waiting for its reset`
        );
    },
    async start(key: string, seconds: number): Promise<void> {
      await until
        .set(key, Date.now() + seconds * 1000, seconds)
        .catch(() => undefined);
    },
  };
}
