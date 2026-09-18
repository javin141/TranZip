/**
 * Browser-side API client. Every call is proxied through the Express server so
 * the LTA AccountKey and OneMap token never reach the browser.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status, kind, service, upstreamStatus } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.service = service;
    this.upstreamStatus = upstreamStatus;
  }

  get isQuotaProblem() {
    return this.status === 403 || this.status === 429 || this.kind === 'rate_limited' || this.kind === 'forbidden';
  }

  get isConfigProblem() {
    return this.status === 503 || this.kind === 'not_configured';
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the TranZip API server. Is `npm run dev` running?', { kind: 'network' });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail = payload?.error || {};
    throw new ApiError(detail.message || `Request failed with HTTP ${response.status}.`, {
      status: response.status,
      kind: detail.kind,
      service: detail.service,
      upstreamStatus: detail.upstreamStatus,
    });
  }

  return payload;
}

export const api = {
  health: (signal) => request('/system/health', { signal }),

  searchPlaces: (query, signal) => request(`/places/search?q=${encodeURIComponent(query)}`, { signal }),

  reverseGeocode: (latitude, longitude, signal) => request(
    `/places/reverse?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`,
    { signal },
  ),

  planJourney: (payload, signal) => request('/journey/plan', { method: 'POST', body: payload, signal }),

  lineLoads: (line, signal) => request(`/loads/lines/${encodeURIComponent(line)}`, { signal }),

  stationLoad: (code, signal) => request(`/loads/station/${encodeURIComponent(code)}`, { signal }),

  busStopLoads: (code, signal) => request(`/loads/bus-stop/${encodeURIComponent(code)}`, { signal }),

  serviceAlerts: (signal) => request('/loads/alerts', { signal }),

  weatherNow: (latitude, longitude, signal) => request(
    `/weather/now?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`,
    { signal },
  ),
};