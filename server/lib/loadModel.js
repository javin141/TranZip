/**
 * Passenger-load model: converts raw LTA DataMall indicators into one shared
 * vocabulary so bus and rail legs can be compared by a single scoring function.
 *
 * Bus  -> `/v3/BusArrival` `Load`: SEA | SDA | LSD
 * Rail -> `/PCDRealTime` & `/PCDForecast` `CrowdLevel`: l | m | h
 */

/** Ordered from least to most crowded. */
export const LOAD_BANDS = {
  seats: {
    key: 'seats',
    label: 'Seats available',
    short: 'Seats',
    detail: 'Plenty of room - you should get a seat.',
    score: 0.2,
    tone: 'good',
  },
  standing: {
    key: 'standing',
    label: 'Standing available',
    short: 'Standing',
    detail: 'Seats taken but the aisle is still comfortable.',
    score: 0.6,
    tone: 'moderate',
  },
  limited: {
    key: 'limited',
    label: 'Limited standing',
    short: 'Limited',
    detail: 'Busy - the vehicle is close to capacity.',
    score: 0.9,
    tone: 'busy',
  },
  unknown: {
    key: 'unknown',
    label: 'No live data',
    short: 'Unknown',
    detail: 'LTA is not reporting load for this service right now.',
    score: null,
    tone: 'unknown',
  },
};

/** LTA bus `Load` codes. */
const BUS_LOAD_TO_BAND = {
  SEA: LOAD_BANDS.seats,
  SDA: LOAD_BANDS.standing,
  LSD: LOAD_BANDS.limited,
};

/** LTA MRT/LRT `CrowdLevel` codes. */
const CROWD_TO_BAND = {
  l: LOAD_BANDS.seats,
  m: LOAD_BANDS.standing,
  h: LOAD_BANDS.limited,
};

/** Approximate crush capacity per LTA bus type - used only for context labels. */
export const BUS_TYPE_INFO = {
  SD: { label: 'Single deck', capacity: 80 },
  DD: { label: 'Double deck', capacity: 120 },
  BD: { label: 'Bendy', capacity: 120 },
};

export function bandFromBusLoad(load) {
  return BUS_LOAD_TO_BAND[String(load || '').toUpperCase()] || LOAD_BANDS.unknown;
}

export function bandFromCrowdLevel(crowdLevel) {
  return CROWD_TO_BAND[String(crowdLevel || '').toLowerCase()] || LOAD_BANDS.unknown;
}

export function busTypeInfo(type) {
  return BUS_TYPE_INFO[String(type || '').toUpperCase()] || null;
}

/** Score used for ranking; `null` (unknown) must not win a comparison. */
export function bandScore(band) {
  return band && typeof band.score === 'number' ? band.score : null;
}

/**
 * Weighted average of a set of band scores. Unknown samples are ignored; when
 * nothing is known the result is `null` (rendered as "no live data").
 */
export function averageScore(scores) {
  const known = scores.filter((score) => typeof score === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, score) => sum + score, 0) / known.length;
}

/**
 * Combines per-leg load samples into a single journey score. Each leg
 * contributes its own score, weighted by how long the passenger is on board,
 * so a short crowded hop never outweighs a long comfortable ride.
 *
 * @param {{ score: number|null, weightMinutes: number }[]} samples
 */
export function journeyLoadScore(samples) {
  const usable = samples.filter((sample) => typeof sample.score === 'number' && sample.weightMinutes > 0);
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((sum, sample) => sum + sample.weightMinutes, 0);
  return usable.reduce((sum, sample) => sum + sample.score * sample.weightMinutes, 0) / totalWeight;
}

/** Qualitative label for a 0-1 journey load score. */
export function scoreToBand(score) {
  if (typeof score !== 'number') return LOAD_BANDS.unknown;
  if (score < 0.45) return LOAD_BANDS.seats;
  if (score < 0.75) return LOAD_BANDS.standing;
  return LOAD_BANDS.limited;
}

/** True when the passenger boards within `windowMinutes` (live data is meaningful). */
export function isLiveWindow(targetTime, windowMinutes = 25, now = Date.now()) {
  const diffMinutes = (new Date(targetTime).getTime() - now) / 60000;
  return diffMinutes <= windowMinutes;
}