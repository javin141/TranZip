/**
 * Turns LTA's `/TrainServiceAlerts` feed into the "what to avoid" shape the
 * rail pathfinder (`railNetwork.findRailPath`) and the journey planner can
 * consume directly, so a live disruption actually changes the routes
 * returned instead of only appearing in a banner. Also normalises the
 * free-bus/free-shuttle fields so the UI can point commuters at them.
 */
import { config } from '../config.js';
import { getTrainServiceAlerts } from './ltaClient.js';
import { isStationCode, lineMeta } from './railLines.js';
import { demoDisruptionFixture } from '../data/test-overrides.js';

let warnedAboutDemoMode = false;

/* ------------------------------------------------------------------ *
 * Demo toggle (DEMO_MODE=1) - a runtime, in-memory switch flipped via
 * POST /api/system/demo-disruption, not a file you hand-edit and restart
 * the server for. Gated twice: the toggle is never sent to the browser
 * unless config.demoMode is on (see routes/system.js), and the setter below
 * refuses to do anything even if called directly when it's off.
 * ------------------------------------------------------------------ */

let demoDisruptionActive = false;

export function isDemoModeAvailable() {
  return config.demoMode;
}

export function getDemoDisruptionActive() {
  return config.demoMode && demoDisruptionActive;
}

/** @returns {boolean} the resulting state (always false when DEMO_MODE isn't set). */
export function setDemoDisruptionActive(enabled) {
  if (!config.demoMode) return false;
  demoDisruptionActive = Boolean(enabled);
  if (demoDisruptionActive && !warnedAboutDemoMode) {
    warnedAboutDemoMode = true;
    console.warn(
      '[disruptions] DEMO MODE ACTIVE - using the fake NEL alert in server/data/test-overrides.js '
      + 'instead of live LTA data until the demo toggle is switched off.',
    );
  }
  return demoDisruptionActive;
}

/** A comma-separated station-code field, or the literal "island wide" free-transport phrase. */
function parseStationField(raw) {
  const text = String(raw || '').trim();
  if (!text) return { stations: [], islandWide: false };
  if (/island\s*wide/i.test(text)) return { stations: [], islandWide: true };
  const stations = text.split(',').map((code) => code.trim().toUpperCase()).filter(isStationCode);
  return { stations, islandWide: false };
}

/** Exported for direct unit testing (see server/tests/disruptions.test.js) - pure, no network/demo-mode involved. */
export function normaliseSegment(raw) {
  const line = String(raw?.Line || '').toUpperCase() || null;
  const stations = String(raw?.Stations || '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(isStationCode);
  const freeBus = parseStationField(raw?.FreePublicBus);
  const shuttle = parseStationField(raw?.FreeMRTShuttle);
  return {
    line,
    lineName: line ? lineMeta(line)?.name || line : null,
    direction: raw?.Direction || null,
    stations,
    freeBusStations: freeBus.stations,
    freeBusIslandWide: freeBus.islandWide,
    shuttleStations: shuttle.stations,
    shuttleIslandWide: shuttle.islandWide,
    shuttleDirection: String(raw?.MRTShuttleDirection || '').trim() || null,
  };
}

function buildDisruption(rawSegments, messages, fetchedAt, simulated) {
  const segments = (rawSegments || []).map(normaliseSegment).filter((segment) => segment.line);
  const stationCodes = new Set();
  const lineCodes = new Set();
  const freeBusStations = new Set();
  const shuttleStations = new Set();
  let freeBusIslandWide = false;
  let shuttleIslandWide = false;
  let shuttleDirection = null;
  for (const segment of segments) {
    lineCodes.add(segment.line);
    for (const code of segment.stations) stationCodes.add(code);
    for (const code of segment.freeBusStations) freeBusStations.add(code);
    for (const code of segment.shuttleStations) shuttleStations.add(code);
    if (segment.freeBusIslandWide) freeBusIslandWide = true;
    if (segment.shuttleIslandWide) shuttleIslandWide = true;
    if (segment.shuttleDirection && !shuttleDirection) shuttleDirection = segment.shuttleDirection;
  }
  return {
    active: segments.length > 0,
    fetchedAt,
    segments,
    stationCodes,
    lineCodes,
    freeBusStations,
    freeBusIslandWide,
    shuttleStations,
    shuttleIslandWide,
    shuttleDirection,
    messages: messages || [],
    simulated,
  };
}

/**
 * @returns {Promise<{
 *   active: boolean,
 *   fetchedAt: string,
 *   segments: ReturnType<typeof normaliseSegment>[],
 *   stationCodes: Set<string>,
 *   lineCodes: Set<string>,
 *   freeBusStations: Set<string>,
 *   freeBusIslandWide: boolean,
 *   shuttleStations: Set<string>,
 *   shuttleIslandWide: boolean,
 *   shuttleDirection: string|null,
 *   messages: { content: string, createdDate: string }[],
 *   simulated: boolean,
 * }>}
 */
export async function getServiceDisruption() {
  if (getDemoDisruptionActive()) {
    return buildDisruption(demoDisruptionFixture.segments, demoDisruptionFixture.messages, new Date().toISOString(), true);
  }

  const alerts = await getTrainServiceAlerts().catch(() => null);
  const rawSegments = alerts?.status === 2 ? (alerts.affectedSegments || []) : [];
  return buildDisruption(rawSegments, alerts?.messages, alerts?.fetchedAt || new Date().toISOString(), false);
}

/**
 * Raw-shaped (status/affectedSegments/messages, matching LTA's own
 * /TrainServiceAlerts response) for the alerts banner - same demo-mode
 * substitution as getServiceDisruption above, so the banner and the journey
 * planner never disagree about whether a disruption is "on".
 */
export async function getTrainServiceAlertsForDisplay() {
  if (getDemoDisruptionActive()) {
    return {
      fetchedAt: new Date().toISOString(),
      status: 2,
      affectedSegments: demoDisruptionFixture.segments,
      messages: demoDisruptionFixture.messages,
      simulated: true,
    };
  }
  const alerts = await getTrainServiceAlerts().catch(() => null);
  return {
    fetchedAt: alerts?.fetchedAt || new Date().toISOString(),
    status: alerts?.status ?? null,
    affectedSegments: alerts?.affectedSegments || [],
    messages: alerts?.messages || [],
    simulated: false,
  };
}

/** Human-readable summary for a warning banner / route note. */
export function disruptionSummary(disruption) {
  if (!disruption?.active) return null;
  const lines = [...disruption.lineCodes].map((code) => lineMeta(code)?.name || code);
  const prefix = disruption.simulated ? '[SIMULATED] ' : '';
  return lines.length === 1
    ? `${prefix}${lines[0]} has a live service disruption. Routes were planned to avoid the affected stations where possible.`
    : `${prefix}${lines.join(', ')} have live service disruptions. Routes were planned to avoid the affected stations where possible.`;
}

/** Note attached to a leg that still has to pass through an affected station. */
export function disruptionNoteForLine(disruption, line) {
  const prefix = disruption?.simulated ? '[SIMULATED] ' : '';
  const segment = disruption?.segments?.find((entry) => entry.line === String(line || '').toUpperCase());
  if (!segment) return `${prefix}Affected by a live LTA service alert.`;
  return `${prefix}Service alert on ${segment.lineName}${segment.direction ? ` (${segment.direction})` : ''} — expect delays or a free shuttle at the affected stations.`;
}
