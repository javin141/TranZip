/**
 * Turns LTA's `/TrainServiceAlerts` feed into the "what to avoid" shape the
 * rail pathfinder (`railNetwork.findRailPath`) and the journey planner can
 * consume directly, so a live disruption actually changes the routes
 * returned instead of only appearing in a banner.
 */
import { getTrainServiceAlerts } from './ltaClient.js';
import { isStationCode, lineMeta } from './railLines.js';
import { disruptionOverride } from '../data/test-overrides.js';

let warnedAboutOverride = false;

function normaliseSegment(raw) {
  const line = String(raw?.Line || '').toUpperCase() || null;
  const stations = String(raw?.Stations || '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(isStationCode);
  return {
    line,
    lineName: line ? lineMeta(line)?.name || line : null,
    direction: raw?.Direction || null,
    stations,
    freeShuttle: Boolean(raw?.FreeMRTShuttle === 'Yes' || raw?.FreePublicBus === 'Yes'),
  };
}

function buildDisruption(rawSegments, messages, fetchedAt, simulated) {
  const segments = (rawSegments || []).map(normaliseSegment).filter((segment) => segment.line);
  const stationCodes = new Set();
  const lineCodes = new Set();
  for (const segment of segments) {
    lineCodes.add(segment.line);
    for (const code of segment.stations) stationCodes.add(code);
  }
  return {
    active: segments.length > 0,
    fetchedAt,
    segments,
    stationCodes,
    lineCodes,
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
 *   messages: { content: string, createdDate: string }[],
 *   simulated: boolean,
 * }>}
 */
export async function getServiceDisruption() {
  // DEV/TEST hook - see server/data/test-overrides.js. Takes over the whole
  // disruption pipeline (rerouting, ranking, UI flags) so a hardcoded alert
  // can be exercised without waiting for a real one.
  if (disruptionOverride?.active) {
    if (!warnedAboutOverride) {
      warnedAboutOverride = true;
      console.warn(
        '[disruptions] TEST OVERRIDE ACTIVE - using the fake alert in server/data/test-overrides.js '
        + 'instead of live LTA data. Set active:false there when done testing.',
      );
    }
    return buildDisruption(disruptionOverride.segments, disruptionOverride.messages, new Date().toISOString(), true);
  }

  const alerts = await getTrainServiceAlerts().catch(() => null);
  const rawSegments = alerts?.status === 2 ? (alerts.affectedSegments || []) : [];
  return buildDisruption(rawSegments, alerts?.messages, alerts?.fetchedAt || new Date().toISOString(), false);
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
