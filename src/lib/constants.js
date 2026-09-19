/**
 * Shared front-end configuration: the fixed rule set from the product brief,
 * the OSM basemap tile source and the load-band palette.
 */

/** Recommendation tolerance: routes within this share of the fastest time are compared by load. */
export const DEFAULT_TOLERANCE_PERCENT = 10;

export const TOLERANCE_OPTIONS = [
  { value: 5, label: 'Strict (5%)', hint: 'Routes up to 5% slower may be recommended if they are emptier.' },
  { value: 10, label: 'Balanced (10%)', hint: 'Routes up to 10% slower may be recommended if they are emptier.' },
  { value: 20, label: 'Comfort first (20%)', hint: 'Willing to travel up to 20% longer for a quieter ride.' },
];

export const MODE_OPTIONS = [
  {
    value: 'TRANSIT',
    label: 'Mixed',
    hint: 'Bus + MRT combined, as OneMap normally plans it.',
  },
  {
    value: 'BUS',
    label: 'Bus only',
    hint: 'Every bus-only alternative, useful for load comparison.',
  },
  {
    value: 'RAIL',
    label: 'MRT only',
    hint: 'Rail-only itineraries with per-station platform crowds.',
  },
];

export const DEFAULT_MODES = ['TRANSIT', 'BUS', 'RAIL'];

/**
 * OpenStreetMap basemap tiles, no API key needed. Configurable via
 * VITE_TILE_URL / VITE_TILE_ATTRIBUTION (see .env.example) so another
 * OSM-based provider (CARTO, MapTiler, Stadia, a self-hosted tile server...)
 * can be swapped in without a code change - useful if traffic ever outgrows
 * the OSM Foundation's tile usage policy, which is meant for light use.
 * The "(c) OpenStreetMap contributors" credit must stay on the map.
 */
export const TILE_URL = import.meta.env.VITE_TILE_URL
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_ATTRIBUTION = import.meta.env.VITE_TILE_ATTRIBUTION
  || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

/** OneMap is still credited separately - place search, routing and reverse geocoding still call OneMap's API. */
export const ONEMAP_ATTRIBUTION = '&copy; <a href="https://www.onemap.gov.sg" target="_blank" rel="noreferrer">OneMap</a> &copy; Singapore Land Authority';

/**
 * Palette shared by load badges, station bars and the map. Keyed by the
 * `tone` field LOAD_BANDS actually carries (server/lib/loadModel.js:
 * good/moderate/busy/unknown) - a prior version of this table was keyed by
 * band name instead (seats/standing/limited), which silently never matched
 * and left every crowd indicator rendering as "unknown" grey.
 *
 * All four colours are checked at >=4.5:1 contrast against white (WCAG AA
 * for normal text) since they're used as text, not just fills - the
 * "unknown" grey originally used Google's usual #80868b, which is only
 * ~3.7:1 and fails.
 */
export const LOAD_TONES = {
  good: { colour: '#188038', soft: '#e6f4ea' },
  moderate: { colour: '#b06000', soft: '#fef7e0' },
  busy: { colour: '#c5221f', soft: '#fce8e6' },
  unknown: { colour: '#5f6368', soft: '#f1f3f4' },
};

export function toneForBand(band) {
  return LOAD_TONES[band?.tone] || LOAD_TONES.unknown;
}

/**
 * Colour for the leg polyline drawn on the map, by mode (walk/bus/other).
 * Bus shares walking's pale sky blue - green clashed with the East-West/
 * Changi line colour and "good" crowd-load status, and a distinct bus blue
 * read too close to the Downtown Line / MRT default. Walking's dashed
 * stroke (see MapView) already tells the two apart, so sharing a colour
 * doesn't cost any clarity.
 */
export const LEG_COLOURS = {
  mrt: '#1a73e8',
  bus: '#64b5f6',
  walk: '#64b5f6',
  other: '#8430ce',
  recommended: '#1a73e8',
};

/**
 * Official Singapore MRT/LRT line colours - mirrors server/lib/railLines.js
 * so a line reads the same colour here as it does on the physical map and
 * wayfinding signage (NSL red, EWL green, NEL purple, CCL orange, DTL blue,
 * TEL brown, the LRT lines grey, JRL teal).
 */
export const RAIL_LINE_COLOURS = {
  NSL: '#d42e12',
  EWL: '#009645',
  CGL: '#009645',
  NEL: '#9900aa',
  CCL: '#fa9e0d',
  CEL: '#fa9e0d',
  DTL: '#005ec4',
  TEL: '#9d5b25',
  BPL: '#7c8087',
  SLRT: '#7c8087',
  PLRT: '#7c8087',
  JRL: '#0099aa',
};

/**
 * Same palette, but with brand colours that are too light to read reliably
 * as text darkened to pass WCAG AA (4.5:1 on white): Circle/Marina Bay
 * Line's orange (#fa9e0d, ~2:1) and the LRT grey (#7c8087, ~4:1, close but
 * short). Every other line's brand colour already clears 4.5:1 on its own.
 */
const RAIL_LINE_TEXT_COLOURS = {
  ...RAIL_LINE_COLOURS,
  CCL: '#a15d00',
  CEL: '#a15d00',
  BPL: '#5f6368',
  SLRT: '#5f6368',
  PLRT: '#5f6368',
};

/** True brand colour - for solid swatches (map polylines, marker dots/circles). */
export function lineSwatchColour(lineCode) {
  return RAIL_LINE_COLOURS[String(lineCode || '').toUpperCase()] || LEG_COLOURS.mrt;
}

/** Contrast-safe variant - for the colour actually used as text. */
export function lineTextColour(lineCode) {
  return RAIL_LINE_TEXT_COLOURS[String(lineCode || '').toUpperCase()] || LEG_COLOURS.mrt;
}