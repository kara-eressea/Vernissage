/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Basic rate limiting on the login and callback endpoints (docs/dashboard.md
 * "Security and operations"). A single-process dashboard needs nothing fancier
 * than a per-key fixed window; keys are client IPs. Not distributed and not
 * meant to be — it blunts brute-force and runaway-redirect loops, no more.
 */

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit for `key`; return true if it is allowed, false if over the limit. */
  check(key: string, now: number): boolean {
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.limit;
  }

  /** Drop expired windows so the map cannot grow without bound. */
  sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
      }
    }
  }
}
