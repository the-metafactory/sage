/**
 * Exponential-backoff retry for transient network failures on gh CLI calls.
 *
 * Triggered by error patterns that strongly indicate a recoverable state:
 * - "error connecting to api.github.com"  (DNS / TCP / SSL setup failure)
 * - "could not resolve host"              (DNS)
 * - "Connection reset by peer"
 * - "Bad Gateway" / "Gateway Timeout"     (GH-side transient)
 * - "rate limit"                          (gh CLI prints this distinctly)
 *
 * NOT retried: auth failures (operator must intervene), validation errors
 * (review-body too long, invalid event), or any 4xx other than 429.
 */

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /error connecting to/i,
  /could not resolve host/i,
  /connection reset/i,
  /connection refused/i,
  /connection timed? out/i,
  /network is unreachable/i,
  /no route to host/i,
  /\b502\b|\b503\b|\b504\b/,
  /bad gateway|gateway time-?out|service unavailable/i,
  /eai_(?:again|nodata)/i,
  /rate limit/i,
  /\bhttp 429\b/i,
];

export function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

export interface RetryOptions {
  /** Max attempt count INCLUDING the first try. Default 6. */
  maxAttempts?: number;
  /** Initial delay in ms (doubled each attempt up to maxDelayMs). Default 1000. */
  baseDelayMs?: number;
  /** Cap on per-attempt delay. Default 30_000 (30s). */
  maxDelayMs?: number;
  /** Random jitter fraction (0..1) applied to each delay. Default 0.2. */
  jitter?: number;
  /** Optional logger called on each retry with attempt + delay info. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Retry `fn` with exponential backoff IF the thrown error matches
 * `isTransientNetworkError`. Non-transient errors propagate immediately
 * (don't waste time retrying a 401).
 *
 * Schedule (default): 1s → 2s → 4s → 8s → 16s → 30s (capped). Total wait
 * across 5 retries ≈ 60s, plenty for a laptop WLAN re-association after a
 * walk between rooms.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const jitter = opts.jitter ?? 0.2;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }
      const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const wobble = exp * jitter * (Math.random() - 0.5) * 2;
      const delay = Math.max(0, Math.round(exp + wobble));
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
