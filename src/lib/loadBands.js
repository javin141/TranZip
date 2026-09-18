/** Human-readable labels for the load bands coming from the API. */
export const LOAD_BANDS = {
  seats: {
    key: 'seats',
    label: 'Seats available',
    short: 'Seats',
    tone: 'good',
    description: 'Plenty of room on board - you should get a seat.',
  },
  standing: {
    key: 'standing',
    label: 'Standing available',
    short: 'Standing',
    tone: 'moderate',
    description: 'Seats taken but there is still comfortable standing room.',
  },
  limited: {
    key: 'limited',
    label: 'Limited standing',
    short: 'Limited',
    tone: 'busy',
    description: 'Busy - the vehicle is close to capacity.',
  },
  unknown: {
    key: 'unknown',
    label: 'No live data',
    short: 'Unknown',
    tone: 'unknown',
    description: 'LTA is not reporting passenger load for this service right now.',
  },
};

/** Accepts an API band object (preferred) or a bare band key. */
export function normaliseBand(band) {
  if (!band) return LOAD_BANDS.unknown;
  if (typeof band === 'string') return LOAD_BANDS[band] || LOAD_BANDS.unknown;
  const base = LOAD_BANDS[band.key] || LOAD_BANDS.unknown;
  return { ...base, ...band, tone: base.tone, label: band.label || base.label };
}
