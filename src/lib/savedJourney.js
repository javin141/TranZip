/**
 * The last successfully planned journey, kept in this browser's localStorage
 * so it can still be shown with no signal (the underground problem). Written
 * after every successful plan; only ever read back to display, never treated
 * as live. The server never sees it. Every read and write is guarded because
 * storage can be blocked or full.
 */

const KEY = 'tranzip:savedJourney';
const VERSION = 1;
// A route line only needs enough points to look right on a phone-sized map.
const MAX_POINTS_PER_LEG = 60;

const round5 = (value) => Math.round(Number(value) * 1e5) / 1e5;

function downsample(points, max) {
  if (!Array.isArray(points)) return [];
  const valid = points.filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  if (valid.length <= max) return valid.map(([lat, lng]) => [round5(lat), round5(lng)]);
  const step = (valid.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => {
    const [lat, lng] = valid[Math.round(index * step)];
    return [round5(lat), round5(lng)];
  });
}

/** A JSON copy of the route with each leg's map line thinned (or dropped, if storage is tight). */
export function slimRoute(route, { keepGeometry = true } = {}) {
  const copy = JSON.parse(JSON.stringify(route));
  for (const leg of copy.legs || []) {
    leg.geometry = keepGeometry ? downsample(leg.geometry, MAX_POINTS_PER_LEG) : [];
  }
  return copy;
}

function cleanPlace(place) {
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { name: String(place?.name || 'Saved place').slice(0, 120), latitude, longitude };
}

/**
 * @param {object} input
 * @param {object} input.plan          the plan response the route came from
 * @param {object} input.route         its recommended route
 * @param {number} [input.savedAtMs]   when the app received it (the device's clock, not the server's)
 */
export function buildSavedJourney({ plan, route, origin, destination, savedAtMs = Date.now() }) {
  return {
    version: VERSION,
    savedAt: new Date(savedAtMs).toISOString(),
    origin: cleanPlace(origin),
    destination: cleanPlace(destination),
    departureTime: plan?.departureTime || null,
    tolerancePercent: plan?.tolerancePercent ?? null,
    routingSource: plan?.routingSource || null,
    planner: plan?.planner || null,
    route: slimRoute(route),
  };
}

/** @returns {boolean} whether it was actually persisted */
export function saveJourney(saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
    return true;
  } catch {
    // Most likely over quota: retry without the map lines, which are the bulk of it.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...saved, route: slimRoute(saved.route, { keepGeometry: false }) }));
      return true;
    } catch {
      return false;
    }
  }
}

export function loadSavedJourney() {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    const saved = JSON.parse(text);
    const savedAtMs = Date.parse(saved?.savedAt);
    if (saved?.version !== VERSION || !Number.isFinite(savedAtMs)) return null;
    if (!Array.isArray(saved.route?.legs) || saved.route.legs.length === 0) return null;
    return { ...saved, origin: cleanPlace(saved.origin), destination: cleanPlace(saved.destination) };
  } catch {
    return null;
  }
}

export function clearSavedJourney() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, or storage blocked - either way there's nothing to clear.
  }
}

/**
 * Wraps a saved journey in the same shape a plan response has, so the normal
 * route card, timeline and map render it unchanged. `receivedAt` is when the
 * data was live, which is what all "how old is this?" labels measure from.
 */
export function planFromSavedJourney(saved) {
  return {
    generatedAt: saved.savedAt,
    receivedAt: Date.parse(saved.savedAt),
    departureTime: saved.departureTime || saved.route.startTime || saved.savedAt,
    origin: saved.origin,
    destination: saved.destination,
    tolerancePercent: saved.tolerancePercent,
    routingSource: saved.routingSource,
    planner: saved.planner,
    routeCount: 1,
    recommendation: null,
    warnings: [],
    routes: [saved.route],
    baselineRoute: null,
    offlineSnapshot: true,
  };
}
