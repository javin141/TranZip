// Temporary probe: verifies LTA $skip paging and OneMap station-code resolution.
import { config } from '../server/config.js';

const key = config.lta.accountKey;
const token = config.oneMap.token;

async function ltaLite(path, params = {}) {
  const url = new URL(config.lta.baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { AccountKey: key, Accept: 'application/json' } });
  return (await res.json()).value || [];
}

async function main() {
  const p0 = await ltaLite('/BusStops', { $skip: 0 });
  const p1 = await ltaLite('/BusStops', { $skip: 500 });
  const p2 = await ltaLite('/BusStops', { $skip: 1000 });
  console.log('BusStops p0', p0[0].BusStopCode, 'p1', p1[0].BusStopCode, 'p2', p2[0].BusStopCode, 'distinct:', new Set([p0[0].BusStopCode, p1[0].BusStopCode, p2[0].BusStopCode]).size);

  const s0 = await ltaLite('/BusServices', { $skip: 0 });
  const s1 = await ltaLite('/BusServices', { $skip: 500 });
  const s2 = await ltaLite('/BusServices', { $skip: 1000 });
  const s3 = await ltaLite('/BusServices', { $skip: 1500 });
  console.log('BusServices pages', s0.length, s1.length, s2.length, s3.length,
    'first:', `${s0[0].ServiceNo}/${s0[0].Direction}`, `${s1[0].ServiceNo}/${s1[0].Direction}`,
    'category sample:', JSON.stringify(s0[0]));

  const r0 = await ltaLite('/BusRoutes', { $skip: 0 });
  const r1 = await ltaLite('/BusRoutes', { $skip: 500 });
  console.log('BusRoutes p0', r0[0].ServiceNo, r0[0].StopSequence, 'p1', r1[0].ServiceNo, r1[0].StopSequence);

  let total = 0;
  const started = Date.now();
  for (let skip = 0; skip < 200000; skip += 500) {
    const rows = await ltaLite('/BusRoutes', { $skip: skip });
    total += rows.length;
    if (rows.length < 500) break;
  }
  console.log('BusRoutes total rows', total, 'in', Date.now() - started, 'ms');

  // OneMap: can every station code be resolved to a name + coordinates?
  const codes = ['CE2', 'TE17', 'TE20', 'DT16', 'JS1', 'JE5', 'SE1', 'SW1', 'PE1', 'PW1', 'BP1', 'CC29', 'NE1', 'NS27', 'EW8', 'CC9', 'NS21', 'DT11', 'CC19', 'DT9', 'NE12', 'CC13', 'EW12', 'DT14', 'NS24', 'NE6', 'CC1', 'EW16', 'NE3', 'TE1', 'TE29', 'DT35', 'CG2', 'NE18', 'DT38', 'TE34', 'CC33'];
  const misses = [];
  for (const code of codes) {
    const url = new URL(`${config.oneMap.baseUrl}/common/elastic/search`);
    url.searchParams.set('searchVal', code);
    url.searchParams.set('returnGeom', 'Y');
    url.searchParams.set('getAddrDetails', 'N');
    url.searchParams.set('pageNum', '1');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    const hit = (json.results || []).find((row) => new RegExp(`\\(([^)]*\\b${code}\\b[^)]*)\\)`, 'i').test(row.SEARCHVAL || ''));
    if (hit) console.log(code, '=>', hit.SEARCHVAL, '|', hit.LATITUDE, hit.LONGITUDE);
    else { misses.push(code); console.log(code, '=> MISS:', (json.results || []).map((r) => r.SEARCHVAL).slice(0, 2).join(' ; ')); }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log('resolved', codes.length - misses.length, 'of', codes.length, 'misses:', misses.join(','));
}

main().catch((error) => { console.error('probe failed:', error); process.exitCode = 1; });