/**
 * Shared front-end configuration: the fixed rule set from the product brief,
 * OneMap basemap presets and the load-band palette.
 */

/** Recommendation tolerance: routes within this share of the fastest time are compared by load. */
export const DEFAULT_TOLERANCE_PERCENT = 10;

export const TOLERANCE_OPTIONS = [
  { value: 0, label: 'Strict (0%)', hint: 'Only the fastest route is ever recommended.' },
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

/** Palette shared by load badges, station bars and the map. */
export const LOAD_TONES = {
  seats: { colour: '#22c55e', soft: 'rgba(34, 197, 94, 0.16)' },
  standing: { colour: '#f59e0b', soft: 'rgba(245, 158, 11, 0.18)' },
  limited: { colour: '#ef4444', soft: 'rgba(239, 68, 68, 0.18)' },
  unknown: { colour: '#94a3b8', soft: 'rgba(148, 163, 184, 0.16)' },
};

export function toneForBand(band) {
  return LOAD_TONES[band?.tone] || LOAD_TONES.unknown;
}

/** Colour for the line/leg polyline drawn on the map. */
export const LEG_COLOURS = {
  mrt: '#2563eb',
  bus: '#0891b2',
  walk: '#94a3b8',
  other: '#7c3aed',
  recommended: '#f97316',
};