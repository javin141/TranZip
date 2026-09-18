/**
 * Builds `server/data/stations.json`: the MRT/LRT station catalog
 * (code -> name, interchanges, line ordering) used for station names, line
 * panels and per-station crowd lookups.
 *
 * Sources
 *  1. LTA DataMall "Train Station" reference dataset via the datastore search
 *     API (every MRT/LRT station with its UUID + station codes).
 *  2. OneMap address search to resolve each station code to its official name
 *     (`NS17` -> "Bishan").
 *
 * Usage
 *   node scripts/build-station-catalog.mjs
 *   LTA_DATASET_ID=<uuid> node scripts/build-station-catalog.mjs   # override dataset
 *
 * The committed catalog lets the app name stations without spending OneMap
 * quota; re-run this script only to refresh it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config } from '../server/config.js';
import { lineForStationCode } from '../server/lib/railLines.js';
import { INTERCHANGE_GROUPS } from '../server/lib/railNetwork.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '../server/data/stations.json');

/**
 * Trailing "(NS17)" / "(EW24 / NS1)" markers in OneMap search labels. The
 * separators used by the OneMap index are inconsistent, so codes are pulled out
 * with a tolerant pattern instead of a strict one.
 */
const CODE_PATTERN = /\b([A-Z]{2}\d{1,2})\b/g;
const LABEL_PATTERN = /^(.*?)\s*(?:MRT|LRT)?\s*(?:STATION|STN)\b/i;
const CODE_IN_LABEL = /\(([^)]+)\)\s*$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ltaDatastore(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      AccountKey: config.lta.accountKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`datastore ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function oneMapSearch(searchValue) {
  const url = new URL(`${config.oneMap.baseUrl}/common/elastic/search`);
  url.searchParams.set('searchVal', searchValue);
  url.searchParams.set('returnGeom', 'Y');
  url.searchParams.set('getAddrDetails', 'N');
  url.searchParams.set('pageNum', '1');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.oneMap.token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`OneMap search ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

/** Walks the datastore search API to collect every station row. */
async function fetchDatasetRows(datasetId) {
  const url = `https://datamall2.mytransport.sg/ltaodataservice/v2/datastore/search/${datasetId}`;
  const rows = [];
  const limit = 500;
  for (let offset = 0; offset < 10000; offset += limit) {
    const result = await ltaDatastore(url, { limit, offset, sort: 'StationCode', order: 'asc', filter: '' });
    const value = result?.value ?? result?.data ?? [];
    rows.push(...value);
    if (value.length < limit) break;
    await sleep(300);
  }
  return rows;
}

/** Finds the "Train Station" dataset id by listing the datastore collection. */
async function discoverDatasetId() {
  const res = await fetch('https://datamall2.mytransport.sg/ltaodataservice/v2/datastore/search', {
    headers: { AccountKey: config.lta.accountKey, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const list = payload?.value ?? payload?.data ?? payload ?? [];
  const match = (Array.isArray(list) ? list : [])
    .find((entry) => /station/i.test(entry?.DatasetName || entry?.name || ''));
  return match?.DatasetId || match?.id || null;
}

const readStationCode = (row) => row.StationCode || row.StationCode2 || row.stationCode || row.Code || null;
const readStationId = (row) => row._id || row.Id || row.ID || row.id || row.StationId || null;
const readStationName = (row) => row.StationName || row.Name || row.name || null;

/**
 * Resolves a station code to `{ name, codes, latitude, longitude }` via the
 * OneMap search index. Multiple cabinet labels share one station name
 * (`EW24 / NS1`), so every bracketed code is collected, not just the first.
 */
async function resolveNameFromOneMap(code) {
  try {
    const payload = await oneMapSearch(code);
    for (const result of payload?.results || []) {
      const label = String(result.SEARCHVAL || '').toUpperCase();
      const bracket = CODE_IN_LABEL.exec(label);
      const inside = bracket ? bracket[1].match(CODE_PATTERN) || [] : [];
      if (!inside.includes(code) && !label.includes(`(${code}`) && !label.startsWith(`${code} `)) continue;

      const match = LABEL_PATTERN.exec(label);
      const name = (match ? match[1] : label.replace(CODE_IN_LABEL, '')).replace(/[-–]\s*$/, '').trim();
      if (!name) continue;

      const latitude = Number(result.LATITUDE);
      const longitude = Number(result.LONGITUDE);
      return {
        name,
        codes: inside.length > 0 ? [...new Set(inside)] : [code],
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
      };
    }
  } catch (error) {
    console.warn(`[catalog] OneMap lookup for ${code} failed: ${error.message}`);
  }
  return null;
}
async function main() {
  if (!config.lta.accountKey) throw new Error('LTA_ACCOUNT_KEY is required in .env');
  if (!config.oneMap.token) throw new Error('ONEMAP_TOKEN is required in .env');

  const datasetId = process.env.LTA_DATASET_ID || await discoverDatasetId();
  let rows = [];
  if (datasetId) {
    console.log(`[catalog] using LTA dataset ${datasetId}`);
    try {
      rows = await fetchDatasetRows(datasetId);
    } catch (error) {
      console.warn(`[catalog] dataset read failed: ${error.message}`);
    }
  } else {
    console.warn('[catalog] no LTA "Train Station" dataset id discovered - using code-space fallback');
  }
  console.log(`[catalog] ${rows.length} station rows read from LTA`);

  /** @type {Map<string, { code: string, name: string|null, id: string|null }>} */
  const byCode = new Map();
  for (const row of rows) {
    for (const raw of [readStationCode(row), row.StationCode2, row.StationCode3]) {
      const code = String(raw || '').toUpperCase();
      if (!lineForStationCode(code)) continue;
      const existing = byCode.get(code) || { code, name: null, id: null };
      byCode.set(code, {
        code,
        name: readStationName(row) || existing.name,
        id: readStationId(row) || existing.id,
      });
    }
  }

  if (byCode.size === 0) {
    // Offline fallback: cover the full code space so the app still has entries.
    console.warn('[catalog] building code-space fallback (names resolved via OneMap)');
    const prefixRanges = {
      NS: 35, EW: 43, CG: 2, NE: 18, CC: 33, CE: 2, DT: 38, TE: 34, BP: 13, SE: 5, SW: 6, PE: 8, PW: 8, JS: 24,
    };
    for (const [prefix, count] of Object.entries(prefixRanges)) {
      for (let index = 1; index <= count; index += 1) {
        byCode.set(`${prefix}${index}`, { code: `${prefix}${index}`, name: null, id: null });
      }
    }
  }

  console.log(`[catalog] resolving names + coordinates for ${byCode.size} station codes via OneMap...`);
  let resolved = 0;
  for (const entry of byCode.values()) {
    const found = entry.name && entry.latitude ? null : await resolveNameFromOneMap(entry.code);
    if (found) {
      entry.name = entry.name || found.name;
      entry.resolvedCodes = [...new Set([...(entry.resolvedCodes || []), ...found.codes])];
      entry.latitude = entry.latitude ?? found.latitude;
      entry.longitude = entry.longitude ?? found.longitude;
      resolved += 1;
    }
    await sleep(120); // stay well inside the OneMap quota
  }
  console.log(`[catalog] ${resolved}/${byCode.size} station codes resolved`);

  // Curated interchanges cover cabinets OneMap does not index (CE2 Marina Bay).
  // Applying them before the prune keeps real stations that the geocoder missed.
  const curatedName = (code) => {
    const group = INTERCHANGE_GROUPS.find((entry) => entry.includes(code));
    if (!group) return null;
    const partner = group
      .filter((other) => other !== code)
      .map((other) => byCode.get(other))
      .find((other) => other?.name);
    return partner ? { name: partner.name, codes: group } : null;
  };
  for (const [code, entry] of byCode) {
    if (entry.name && entry.latitude != null) continue;
    const curated = curatedName(code);
    if (!curated) continue;
    entry.name = entry.name || curated.name;
    entry.resolvedCodes = [...new Set([...(entry.resolvedCodes || []), ...curated.codes])];
    const partner = curated.codes
      .map((other) => byCode.get(other))
      .find((other) => other && other.latitude != null);
    if (partner) {
      entry.latitude = entry.latitude ?? partner.latitude;
      entry.longitude = entry.longitude ?? partner.longitude;
    }
  }

  // Anything still without a name or coordinates is a code that is either
  // reserved for a future stage (TE32) or not a station at all.
  const pruned = [...byCode.entries()]
    .filter(([, entry]) => !entry.name && entry.latitude == null)
    .map(([code]) => code);
  if (pruned.length > 0) {
    console.log(`[catalog] dropping ${pruned.length} unresolved code(s): ${pruned.join(' ')}`);
    for (const code of pruned) byCode.delete(code);
  }

  // Group codes by station name so interchanges share `codes` and `lines`,
  // then apply the curated interchange table for cabinets OneMap does not
  // index by name (`CE2` Marina Bay shares `NS27`, and so on).
  const byName = new Map();
  for (const entry of byCode.values()) {
    const key = (entry.name || entry.code).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry.code);
  }

  const groups = new Map();
  for (const entry of byCode.values()) {
    const codes = [...new Set([
      entry.code,
      ...(entry.resolvedCodes || []),
      ...(byName.get((entry.name || entry.code).toLowerCase()) || []),
    ])];
    groups.set(entry.code, codes);
  }
  for (const group of INTERCHANGE_GROUPS) {
    const present = group.filter((code) => byCode.has(code));
    if (present.length < 2) continue;
    const merged = [...new Set([...present, ...present.flatMap((code) => groups.get(code) || [])])];
    for (const code of merged) if (groups.has(code)) groups.set(code, merged);
  }
  const lines = {};
  const stationOutput = {};

  for (const entry of byCode.values()) {
    const codes = groups.get(entry.code).filter((code) => byCode.has(code)).sort((a, b) => a.localeCompare(b));
    const lineSet = [...new Set(codes.map((code) => lineForStationCode(code)).filter(Boolean))].sort();
    stationOutput[entry.code] = {
      code: entry.code,
      id: entry.id,
      name: entry.name,
      latitude: entry.latitude ?? null,
      longitude: entry.longitude ?? null,
      codes,
      lines: lineSet,
    };

    const primaryLine = lineForStationCode(entry.code);
    if (!primaryLine) continue;
    lines[primaryLine] = lines[primaryLine] || { code: primaryLine, stations: [] };
    if (!lines[primaryLine].stations.includes(entry.code)) lines[primaryLine].stations.push(entry.code);
  }

  // Order each line by numeric station index (NS1 -> NS28).
  for (const line of Object.values(lines)) {
    line.stations.sort(
      (a, b) => Number.parseInt(a.replace(/\D/g, ''), 10) - Number.parseInt(b.replace(/\D/g, ''), 10),
    );
  }

  const byId = {};
  for (const entry of Object.values(stationOutput)) {
    if (entry.id) byId[String(entry.id).toLowerCase()] = { code: entry.code, name: entry.name };
  }

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: datasetId ? `LTA DataMall datastore ${datasetId} + OneMap names/coordinates` : 'code-space scan + OneMap names/coordinates',
    stationCount: Object.keys(stationOutput).length,
    codeCount: Object.keys(stationOutput).length,
    locatedCount: Object.values(stationOutput).filter((entry) => entry.latitude != null).length,
    lines,
    byCode: stationOutput,
    byId,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`[catalog] wrote ${OUTPUT_PATH} (${catalog.stationCount} stations across ${Object.keys(lines).length} lines)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[catalog] failed:', error.message);
    process.exitCode = 1;
  });
}