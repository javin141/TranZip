# TranZip

A mobile-first, load-aware journey planner for Singapore, built for the "Smart Commuter Companion" hackathon brief. It plans bus and MRT/LRT routes the way OneMap or Google Maps do, but "recommended" doesn't mean fastest: it means **the least crowded route within a time budget you set**, using LTA DataMall's live passenger load. It also reroutes around live MRT disruptions and can favour less walking when it's raining or hot.

**Who it's for.** Arjun commutes from Punggol to one-north. He values comfort and predictability over shaving minutes: he'd rather leave up to an hour later than stand in a crush. Every route shows its live crowd level, and the recommendation trades a little time for comfort, within a tolerance he chooses.

## What it does

- **Crowd-aware routing.** Live bus load and MRT platform crowding on every leg. The recommended route is the quietest one within 5, 10 or 20% of the fastest.
- **Leave later.** Pick a future departure and it uses LTA's 30-minute crowd forecast instead of the live reading.
- **Disruption rerouting.** An active MRT alert blocks those stations in TranZip's own rail graph, so it finds a real detour. The map shows your usual route, the affected stretch and "+11 min vs usual", and calls out any free bus or shuttle.
- **Weather-aware (opt-in).** When it's raining or hot, it favours less time on foot.
- **A "Today" card.** Save your usual trip (kept in your browser only) and the app opens with one line: fine as usual, leave later for a quieter ride, or a disruption to route around. [Details](docs/today-card.md).
- **Honest time ranges.** "28–35 min" estimates, labelled as estimates, from live arrivals, crowding and rain. [How they're built](docs/how-it-works.md#travel-time-ranges-heuristics-not-predictions).
- **Works underground.** No signal? It opens, shows your last journey, and dims and age-labels anything that was live. [Details](docs/offline.md).
- **Mobile-first.** A map with a draggable bottom sheet you can reach one-handed, a large-text **A+** toggle, real MRT line colours, and one "Walk" bubble per stretch of walking.
- **Three routing sources, one fallback chain.** Google Routes (optional), then OneMap, then TranZip's own LTA-based planner. It works end to end with just an LTA key and a OneMap token.

## Quick start

Needs **Node.js 22 or later**.

| Key | Needed? | Where to get it |
|---|---|---|
| `LTA_ACCOUNT_KEY` | **Required** | [datamall.lta.gov.sg](https://datamall.lta.gov.sg): free, arrives by email within minutes. Live load, alerts and the fallback planner's data. |
| `ONEMAP_TOKEN` | **Required** | [onemap.gov.sg/apidocs/register](https://www.onemap.gov.sg/apidocs/register): free. Place search and geocoding. Also set `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` so the server renews the token, which expires after about 3 days. |
| `GOOGLE_MAPS_API_KEY` | Optional | A [Routes API](https://developers.google.com/maps/documentation/routes) key. Google becomes the primary routing source. |
| Map tiles | No key | OpenStreetMap by default. To switch provider, change `VITE_TILE_URL` (see `.env.example`). |

```bash
cp .env.example .env      # fill in LTA_ACCOUNT_KEY and ONEMAP_TOKEN at minimum
npm install
npm run dev               # API on :8787, web app on :5173 (open http://localhost:5173)
```

The dev server proxies `/api/*` to the Express server, so your keys never reach the browser.

```bash
npm test                  # offline, fixture-only tests (no network calls)
npm run build && npm start   # production build, served on :8787
```

## Try the demo: Punggol → one-north

1. Plan **Punggol MRT Station → one-north MRT Station**. You'll see ranked routes; the recommended one is the least crowded within your tolerance, not necessarily the fastest.
2. Switch Departure to **Later** and push the time forward: it re-ranks using the crowd forecast, which is Arjun's "wait out the crush" behaviour.
3. **Simulate a disruption:** set `DEMO_MODE=1` in your `.env`, restart the server, then tick **"Demo: simulate NEL disruption (Punggol area)"** and plan again. The usual NEL + CCL route gets a "Service alert" ribbon and is skipped, and a bus 666 + EWL + CCL route is recommended instead, marked "Rerouted". Everything the simulation touches is labelled `[SIMULATED]`.

The disruption switch is server-wide (everyone on that server sees it), and it doesn't exist at all unless `DEMO_MODE=1`. `.env` isn't shared through git, so each teammate sets it themselves. On Vercel the state lives in per-instance memory and can appear to flip back, so run the demo locally. To simulate rain or heat, hand-edit `weatherOverride` in `server/data/test-overrides.js`.

## The numbers, at a glance

Every number on screen is explained in [docs/how-it-works.md](docs/how-it-works.md). The headline ones:

| What you see | In one line |
|---|---|
| **Recommended** | Lowest crowd load among routes within your tolerance (5, 10 or 20%) of the fastest. No load data counts as neutral (0.5), and disrupted routes are skipped when a clean one exists. |
| **Crowd band** | Seats = 0.2, standing = 0.6, limited standing = 0.9. A route's score is the average of its legs, weighted by time on board. |
| **"28–35 min"** | Heuristic per-leg ranges (walk ±10%, +15% more in rain; bus wait from the next 2–3 arrivals, ride ±10%; rail ±5%, or +0–3 min if the platform is crowded). Not a statistical prediction. |
| **Not live / "14 min old"** | Crowd data that is offline or more than 10 minutes old is dimmed and labelled with its age. |
| **Raining / hot** | 0.2 mm or more in 5 minutes (or a rain forecast) counts as raining; 32°C or more is hot. "Avoid weather" blends walking share in at 50%. |
| **Walking time** | Straight-line distance × 1.25 at 1.25 m/s in the fallback planner; Google and OneMap supply their own. Times marked `~` are derived, not reported. |
| **Today advice** | Up to 5 departures, 15 minutes apart; "quieter" means a strictly better crowd band. Capped at 40 upstream calls per check, cached for 45 seconds. |
| **Fare** | A distance-banded estimate, only for routes from the fallback planner. |

## Known limitations

- Live bus data stops overnight (roughly 00:30–05:30), and LTA publishes no bus-load forecast, so future departures rely on rail crowding.
- There is no background push: the Today card and its optional notification only work while the app is open.
- Offline it shows only your last planned journey, and the map tiles aren't cached.
- OpenStreetMap's tile server is for light use: fine for a demo, switch provider for real traffic.
- "Avoid weather" cuts time on foot; it doesn't follow sheltered walkways.

The full list is in [docs/limitations.md](docs/limitations.md).

## Data sources & licences

| Source | Used for | Licence |
|---|---|---|
| [LTA DataMall](https://datamall.lta.gov.sg) | Bus arrivals + load, MRT/LRT platform crowd, service alerts, bus routes/stops/services reference data | [Singapore Open Data Licence](https://data.gov.sg/open-data-licence) |
| [NEA via data.gov.sg](https://data.gov.sg) | Real-time rainfall, air temperature, 2-hour weather forecast | [Singapore Open Data Licence](https://data.gov.sg/open-data-licence) |
| [OneMap](https://www.onemap.gov.sg) (Singapore Land Authority) | Place search, reverse geocoding, optional routing, map click-to-pin | OneMap API terms — attribution required, shown in the footer and in the map's attribution control (OneMap no longer supplies the map tiles) |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | Basemap tiles (`tile.openstreetmap.org`) | Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Tiles are served by the OpenStreetMap Foundation under its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/): light use only, attribution required (shown on the map), no bulk downloading or pre-fetching, no uptime guarantee. That is fine for a demo; for real traffic switch `VITE_TILE_URL` to another OSM-based provider. |
| [Google Maps Routes API](https://developers.google.com/maps/documentation/routes) (optional) | Primary transit routing, when a key is configured | Google Maps Platform Terms of Service (commercial, not open data) |

Every source is credited in the app footer, and the map's attribution control (OpenStreetMap contributors and OneMap) is always visible on the map, including on phones where the footer is hidden.

## Future Roadmap

- **Sheltered Walkway Routing:** Provide multiple sheltered walking options showing the coverage vs distance trade-off (e.g., *5 min walk with 75% shelter* vs *8 min walk with 90% shelter*).
- **Accessibility & Step-Free Routing:** Routing prioritizing lifts, step-free paths, and avoiding steep hills or stations with out-of-service elevators.
- **Train Carriage Crowd Density:** Recommend the least crowded train carriage and boarding door for a higher chance of getting a seat by using sensors to be installed in train carriages.
- **Proactive Disruption Alerts:** Send a heads-up notification before you leave home if your saved daily route has an active train breakdown.
- **Shared Bike & PCN Alternatives:** Suggest shared bikes (e.g., Anywheel) or park connectors for the last mile when feeder buses are packed or delayed.

## More documentation

- [How every number is calculated](docs/how-it-works.md): recommendation, load, ranges, walking times
- [Today card](docs/today-card.md): the usual-trip advice
- [No signal underground](docs/offline.md): offline behaviour
- [Privacy](docs/privacy.md): what's stored, where, for how long
- [Limitations](docs/limitations.md)

## Project structure

```
src/         React + Vite frontend (map, planner, route cards, Today card, offline handling)
public/      Manifest, icons and sw.js (the app-shell service worker)
server/      Express API proxy: all third-party keys live here, never in the browser
server/lib/  Routing, load scoring, ranges, disruption and weather logic, LTA/OneMap/Google clients
server/tests/, src/lib/*.test.js   The offline test suite (npm test)
docs/        The detailed documentation above
```
