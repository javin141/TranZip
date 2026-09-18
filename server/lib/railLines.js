/**
 * Single source of truth for Singapore rail line metadata.
 *
 * `code` matches the `TrainLine` values accepted by LTA DataMall's
 * PCDRealTime / PCDForecast endpoints, so a station code prefix always maps
 * straight onto the line whose crowd data must be fetched.
 */

export const RAIL_LINES = {
  NSL: { code: 'NSL', name: 'North-South Line', short: 'NSL', colour: '#d42e12', crowdApi: true },
  EWL: { code: 'EWL', name: 'East-West Line', short: 'EWL', colour: '#009645', crowdApi: true },
  CGL: { code: 'CGL', name: 'Changi Airport Branch', short: 'CGL', colour: '#009645', crowdApi: true, parent: 'EWL' },
  NEL: { code: 'NEL', name: 'North East Line', short: 'NEL', colour: '#9900aa', crowdApi: true },
  CCL: { code: 'CCL', name: 'Circle Line', short: 'CCL', colour: '#fa9e0d', crowdApi: true },
  CEL: { code: 'CEL', name: 'Marina Bay Branch', short: 'CEL', colour: '#fa9e0d', crowdApi: true, parent: 'CCL' },
  DTL: { code: 'DTL', name: 'Downtown Line', short: 'DTL', colour: '#005ec4', crowdApi: true },
  TEL: { code: 'TEL', name: 'Thomson-East Coast Line', short: 'TEL', colour: '#9d5b25', crowdApi: true },
  BPL: { code: 'BPL', name: 'Bukit Panjang LRT', short: 'BPL', colour: '#7c8087', crowdApi: true },
  SLRT: { code: 'SLRT', name: 'Sengkang LRT', short: 'SLRT', colour: '#7c8087', crowdApi: true },
  PLRT: { code: 'PLRT', name: 'Punggol LRT', short: 'PLRT', colour: '#7c8087', crowdApi: true },
  JRL: { code: 'JRL', name: 'Jurong Region Line', short: 'JRL', colour: '#0099aa', crowdApi: false },
};

/** Station-code prefix -> rail line code. */
export const PREFIX_TO_LINE = {
  NS: 'NSL',
  EW: 'EWL',
  CG: 'CGL',
  NE: 'NEL',
  CC: 'CCL',
  CE: 'CEL',
  DT: 'DTL',
  TE: 'TEL',
  BP: 'BPL',
  SE: 'SLRT',
  SW: 'SLRT',
  PE: 'PLRT',
  PW: 'PLRT',
  JS: 'JRL',
  JE: 'JRL',
  JW: 'JRL',
};

const STATION_CODE_PATTERN = /^([A-Z]{2})\d+$/;

/** `EW24` -> `EWL`, `CG2` -> `CGL`, `SE1` -> `SLRT` (null for non-station codes). */
export function lineForStationCode(stationCode) {
  const match = STATION_CODE_PATTERN.exec(String(stationCode || '').toUpperCase());
  if (!match) return null;
  return PREFIX_TO_LINE[match[1]] || null;
}

export function lineMeta(lineCode) {
  return RAIL_LINES[String(lineCode || '').toUpperCase()] || null;
}

export function lineColour(lineCode) {
  return lineMeta(lineCode)?.colour || '#64748b';
}

/** True for station codes that identify an MRT/LRT station rather than a bus stop. */
export function isStationCode(code) {
  return Boolean(lineForStationCode(code));
}

/** LTA DataMall `TrainLine` codes that expose crowd data today. */
export const CROWD_API_LINES = Object.values(RAIL_LINES)
  .filter((line) => line.crowdApi)
  .map((line) => line.code);