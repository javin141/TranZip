/**
 * Thin fetch wrapper shared by the LTA DataMall and OneMap clients.
 *
 * Adds: request timeout, retry-with-backoff for rate limiting / transient
 * upstream failures, and a typed error (`UpstreamError`) that carries enough
 * context for the API layer to translate into an actionable HTTP response.
 */

export class UpstreamError extends Error {
  constructor(message, { service, status, url, body, kind = 'upstream' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
    this.status = status;
    this.url = url;
    this.body = typeof body === 'string' ? body.slice(0, 400) : body;
    this.kind = kind;
  }

  toJSON() {
    return {
      service: this.service,
      status: this.status,
      kind: this.kind,
      message: this.message,
      url: this.url,
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {object} options
 * @param {Record<string,string>} [options.headers]
 * @param {string} options.service        label used in error messages
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.backoffMs]  delays for retryable statuses (429/403/5xx, network errors)
 */
export async function requestJson(url, {
  headers = {},
  service = 'upstream',
  timeoutMs = 20000,
  backoffMs = [1500, 4000],
} = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      const isTimeout = error?.name === 'AbortError';
      if (attempt < backoffMs.length) {
        await sleep(backoffMs[attempt]);
        attempt += 1;
        continue;
      }
      throw new UpstreamError(
        `${service} request failed: ${isTimeout ? `timed out after ${timeoutMs}ms` : error.message}`,
        { service, url, kind: isTimeout ? 'timeout' : 'network' },
      );
    }
    clearTimeout(timer);

    const text = await response.text();

    if (response.ok) {
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError(`${service} returned a non-JSON body`, {
          service, status: response.status, url, body: text, kind: 'schema',
        });
      }
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < backoffMs.length) {
      await sleep(backoffMs[attempt]);
      attempt += 1;
      continue;
    }

    const kind = response.status === 401 || response.status === 403 ? 'forbidden'
      : response.status === 404 ? 'not_found'
        : response.status === 429 ? 'rate_limited'
          : 'upstream';

    throw new UpstreamError(`${service} responded ${response.status}`, {
      service, status: response.status, url, body: text, kind,
    });
  }
}

export function buildUrl(base, path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : base + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Parses the `exp` claim out of a OneMap JWT without verifying the signature. */
export function decodeJwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}