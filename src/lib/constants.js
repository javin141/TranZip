/**
 * Shared front-end configuration: the fixed rule set from the product brief,
 * OneMap basemap presets and the load-band palette.
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

/** OneMap basemap styles (key-less tile endpoints documented in /apidocs/maps). */
export const BASEMAP_STYLES = [
  { value: 'Default', label: 'Default', path: 'default' },
  { value: 'Grey', label: 'Grey', path: 'grey' },
  { value: 'Night', label: 'Night', path: 'night' },
  { value: 'Original', label: 'Original', path: 'original' },
];

export const ONEMAP_ATTRIBUTION = '&copy; <a href="https://www.onemap.gov.sg" target="_blank" rel="noreferrer">OneMap</a> &copy; Singapore Land Authority';

/**
 * Palette shared by load badges, station bars and the map. Keyed by the
 * `tone` field LOAD_BANDS actually carries (server/lib/loadModel.js:
 * good/moderate/busy/unknown) - a prior version of this table was keyed by
 * band name instead (seats/standing/limited), which silently never matched
 * and left every crowd indicator rendering as "unknown" grey.
 */
export const LOAD_TONES = {
  good: { colour: '#188038', soft: '#e6f4ea' },
  moderate: { colour: '#b06000', soft: '#fef7e0' },
  busy: { colour: '#c5221f', soft: '#fce8e6' },
  unknown: { colour: '#80868b', soft: '#f1f3f4' },
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
 * Same palette, but with the Circle/Marina Bay Line's brand orange darkened
 * for use as actual text - #fa9e0d is only ~2:1 contrast on white, well
 * under the ~4.5:1 needed to read reliably. Every other line's brand colour
 * is already dark enough on its own.
 */
const RAIL_LINE_TEXT_COLOURS = {
  ...RAIL_LINE_COLOURS,
  CCL: '#a15d00',
  CEL: '#a15d00',
};

/** True brand colour - for solid swatches (map polylines, marker dots/circles). */
export function lineSwatchColour(lineCode) {
  return RAIL_LINE_COLOURS[String(lineCode || '').toUpperCase()] || LEG_COLOURS.mrt;
}

/** Contrast-safe variant - for the colour actually used as text. */
export function lineTextColour(lineCode) {
  return RAIL_LINE_TEXT_COLOURS[String(lineCode || '').toUpperCase()] || LEG_COLOURS.mrt;
}