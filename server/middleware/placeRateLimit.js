/**
 * Very small sliding-window rate limiter for outbound OneMap search traffic.
 *
 * OneMap applies a quota per account, and the search boxes fan out one request
 * per keystroke burst, so requests are capped and the rest are answered with
 * 429 + Retry-After (the client debounces and retries).
 */

const WINDOW_MS = 10 * 1000;
const MAX_REQUESTS_PER_WINDOW = 40;

/** @type {number[]} */
let hits = [];

export function placeRateLimit(req, res, next) {
  const now = Date.now();
  hits = hits.filter((timestamp) => now - timestamp < WINDOW_MS);
  if (hits.length >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (now - hits[0]);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({
      error: {
        message: 'Too many place searches in a short period. Please slow down.',
        kind: 'rate_limited',
        retryAfterMs,
      },
    });
  }
  hits.push(now);
  return next();
}