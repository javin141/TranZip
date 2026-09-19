/**
 * Shared display formatting helpers used by the API layer so labels look
 * consistent no matter which upstream produced them.
 */

const SMALL_WORDS = new Set(['of', 'at', 'the', 'and', 'de', 'la', 'by', 'in', 'on', 'to']);

/** Acronyms that must stay upper-case in station and stop names. */
const ACRONYMS = new Set(['mrt', 'lrt', 'stn', 'opp', 'blk', 'ave', 'rd', 'st', 'csc', 'int', 'ctrl', 'ctr', 'pl', 'ter', 'dr', 'cl', 'ln', 'sg', 'apt', 'jc', 'it']);

/**
 * `BISHAN` -> `Bishan`, `OPP RAFFLES INSTN` -> `Opp Raffles Instn`,
 * `CITY HALL MRT STATION` -> `City Hall MRT Station`.
 */
export function formatStopName(rawName) {
  const text = String(rawName ?? '').trim();
  if (!text) return '';
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      if (ACRONYMS.has(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** `NS17` + `Bishan` -> `Bishan (NS17)`. */
export function stationLabel(name, code) {
  const formatted = formatStopName(name);
  if (formatted && code) return `${formatted} (${code})`;
  return formatted || code || '';
}

/**
 * Milliseconds since the epoch from a leg/route time, or null. Routing sources
 * disagree on the format: ISO strings (LTA-native planner, Google) versus epoch
 * milliseconds (OneMap), and `Date.parse` on a bare number returns NaN.
 */
export function parseTimeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' || /^\d{10,}$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function titleCase(rawText) {
  return formatStopName(rawText);
}