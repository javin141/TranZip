/**
 * Per-client sliding-window rate limiter for endpoints that fan out to many
 * upstream calls (unlike `placeRateLimit`, which is one global bucket).
 * In-memory, so it resets on restart and isn't shared between instances.
 */

export function createRateLimiter({ windowMs, max, message }) {
  /** @type {Map<string, number[]>} */
  const hitsByClient = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const client = req.ip || 'unknown';
    const hits = (hitsByClient.get(client) || []).filter((timestamp) => now - timestamp < windowMs);

    if (hits.length >= max) {
      hitsByClient.set(client, hits);
      const retryAfterMs = windowMs - (now - hits[0]);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: { message, kind: 'rate_limited', retryAfterMs } });
    }

    hits.push(now);
    hitsByClient.set(client, hits);

    // Keep the map from growing without bound on a long-running server.
    if (hitsByClient.size > 1000) {
      for (const [key, timestamps] of hitsByClient) {
        if (timestamps.every((timestamp) => now - timestamp >= windowMs)) hitsByClient.delete(key);
      }
    }
    return next();
  };
}
