# TranZip

**TranZip** is a mobile-first, load-aware journey planner for Singapore's public transport network. Built for the "Smart Commuter Companion" hackathon brief, it plans bus + MRT/LRT routes the way OneMap or Google Maps do — but the recommendation isn't "fastest wins." It's **the least crowded route within a time budget you set**, using LTA DataMall's live passenger-load data, and it actively reroutes around live MRT service disruptions and biases toward less time on foot when it's raining or hot.

## Who it's for

**Arjun** is a multi-modal, flexible-start commuter who travels from **Punggol to one-north** most weekdays. He values comfort and predictability over shaving a few minutes off his trip — he'd rather leave up to an hour later than get stuck in a crush, and he cares about how much of his trip is spent standing on a packed platform or walking uncovered in the rain. TranZip is built around that trade-off: every route shown is annotated with its live crowd level, and the "recommended" pick is chosen by comfort within a tolerance, not raw speed.

## What it does

- **Live crowd-aware routing.** Every bus leg carries LTA's live `Load` (seats / standing / limited-standing available); every MRT/LRT leg carries live platform `CrowdLevel` per station. Routes are ranked by a time-weighted average of this across the whole trip.
- **A configurable comfort/speed trade-off.** Pick "Strict" (5%), "Balanced" (10%) or "Comfort first" (20%) — TranZip only ever recommends a slower route if it's within that percentage of the fastest one, and only when it's meaningfully less crowded.
- **Flexible departure.** "Leave now" or "leave later" — pick a future departure time and TranZip re-evaluates crowd forecasts (LTA's 30-minute `/PCDForecast`) for that time instead of the live 10-minute reading, which is exactly Arjun's "leave later to avoid the crush" behaviour.
- **Live disruption-aware rerouting.** When LTA reports an active MRT/LRT service alert, TranZip treats the affected stations as blocked in its own rail-network graph and actively searches for a route around them — not just a warning banner. See [Demo journey](#demo-journey-punggol--one-north) below to trigger this without waiting for a real disruption.
- **Weather-aware ranking (opt-in).** When it's raining or hot (live NEA data), an in-app toggle biases the recommendation toward routes with less time spent walking outdoors.
- **A "Today" card for your usual trip.** Save your regular commute once (stored only in your browser) and the app opens with one line about it: fine as usual, leave later for a quieter ride, or a disruption to route around. See [Today card](#today-card-my-usual-trip). There is no background push — it only works while the app is open.
- **Three routing sources, one fallback chain.** Google Maps Routes API (optional) → OneMap's routing service → an LTA DataMall-native local planner (bus routes + rail topology) that TranZip builds and ranks itself. If a source is unavailable or unconfigured, the app falls through to the next one automatically — it works end-to-end on just an LTA key and an OneMap token.

## Future Roadmap

- **Sheltered Walkway Routing:** Provide multiple sheltered walking options showing the coverage vs distance trade-off (e.g., *5 min walk with 75% shelter* vs *8 min walk with 90% shelter*).
- **Accessibility & Step-Free Routing:** Routing prioritizing lifts, step-free paths, and avoiding steep hills or stations with out-of-service elevators.
- **Train Carriage Crowd Density:** Recommend the least crowded train carriage and boarding door for a higher chance of getting a seat by using sensors to be installed in train carriages.
- **Proactive Disruption Alerts:** Send a heads-up notification before you leave home if your saved daily route has an active train breakdown.
- **Shared Bike & PCN Alternatives:** Suggest shared bikes (e.g., Anywheel) or park connectors for the last mile when feeder buses are packed or delayed.

## Prerequisites

- **Node.js 22 or later** (`node --version` to check; the test runner's file globs need it). No database, no external services to install.
- A modern browser (Chrome, Edge, Firefox, Safari).

## Getting your API keys

Two are required; everything else is optional and the app degrades gracefully without it.

| Key | Required? | Where to get it |
|---|---|---|
| `LTA_ACCOUNT_KEY` | **Required** | Register at [datamall.lta.gov.sg](https://datamall.lta.gov.sg), then request an AccountKey. It's free and typically arrives by email within minutes. Powers bus/MRT live load, service alerts, and the fallback planner's bus/rail reference data. |
| `ONEMAP_TOKEN` | **Required** | Register at [onemap.gov.sg/apidocs/register](https://www.onemap.gov.sg/apidocs/register) for a free account. Powers place search and reverse geocoding (and turn-by-turn routing, if enabled for your account). Also set `ONEMAP_EMAIL`/`ONEMAP_PASSWORD` so the server can auto-renew the token — OneMap tokens expire after ~3 days. |
| `GOOGLE_MAPS_API_KEY` | Optional | [Google Cloud Console](https://developers.google.com/maps/documentation/routes) → enable the Routes API → create a key. Only needed if you want Google as the primary routing source; the app works fully without it. |
| Basemap key | Not needed | The map uses OpenStreetMap's own tile server, which needs no key. If traffic ever outgrows its light-use policy, `.env.example` shows how to switch to CARTO ([free key](https://carto.com/basemaps/apikey/), no account) or MapTiler ([free key](https://cloud.maptiler.com)) by changing `VITE_TILE_URL`. |

## Setup

```bash
cp .env.example .env      # then fill in LTA_ACCOUNT_KEY and ONEMAP_TOKEN at minimum
npm install
npm run dev                # starts the API proxy (:8787) and the Vite dev server (:5173) together
```

Open `http://localhost:5173`. The dev server proxies `/api/*` to the Express server, so the browser never sees your API keys.

**Production build:**

```bash
npm run build && npm start   # builds to dist/, then serves it from the same Express server on :8787
```

**Tests:**

```bash
npm test    # node's built-in test runner over server/tests/*.test.js and src/lib/*.test.js, offline and fixture-only
```

## Demo journey: Punggol → one-north

This is Arjun's actual commute, and it's the scenario TranZip's own test fixtures are tuned around.

1. Start the app (`npm run dev`) with `LTA_ACCOUNT_KEY` and `ONEMAP_TOKEN` set.
2. In the planner, set **From** to `Punggol MRT Station` (or click the map near 1.4051, 103.9023) and **To** to `one-north MRT Station` (1.2998, 103.7876).
3. Plan the journey. You'll see several ranked routes — the recommended one is the least crowded option within your chosen time tolerance, not necessarily the fastest.
4. Try **"Later"** departure and push the time forward — this re-evaluates against LTA's crowd *forecast* rather than the live reading, showing how leaving later changes which route (and how crowded it is) gets recommended. This is Arjun's "wait out the crush" behaviour.
5. If it's genuinely raining/hot in Singapore right now, a weather chip appears automatically; toggle it on and watch the recommendation shift toward less time on foot. (To simulate this on demand instead of waiting for real weather, see `weatherOverride` below.)

### Triggering the simulated North East Line disruption

Punggol → one-north normally rides the North East Line from Punggol to Serangoon before transferring to the Circle Line. TranZip ships a **[SIMULATED]** disruption on exactly that stretch (the `demoDisruptionFixture` in `server/data/test-overrides.js`), switched on from the UI rather than by editing code:

1. Set `DEMO_MODE=1` in your `.env` and restart the server. With `DEMO_MODE` unset (the default) the switch below does not exist in the page at all, and the server refuses to turn the simulation on even if called directly.
2. In the planner, tick **"Demo: simulate NEL disruption (Punggol area)"**. The alerts banner switches to the fixture immediately.
3. Re-plan Punggol → one-north. You'll see:
   - A `[SIMULATED]` warning banner naming the affected line.
   - The previously-fastest NEL+CCL route now marked with a **"Service alert"** ribbon and excluded from the recommendation.
   - A different route — a bus (service 666) connecting to the East-West Line then the Circle Line — now recommended instead, marked **"Rerouted"**.
   - Rail-only mode (if you restrict route types) correctly shows *no* route at all for that stretch, because there's genuinely no parallel MRT line there in real life either — TranZip doesn't invent a fake rail bypass.
4. Untick the switch when you're done. Every screen the simulation touches (alerts banner, route ribbons, free-bus/shuttle note, map tooltips) is labelled `[SIMULATED]`, and API responses carry `simulated: true`, so it can never be mistaken for a real alert. **The switch is server-wide:** while it's on, *every* user of that server sees the fake disruption instead of live LTA alerts.

`weatherOverride` in the same file is still a hand-edit (`weatherOverride.active = true`, then restart the server), for simulating rain/heat without waiting for real Singapore weather. Simulated rain also widens walking-time ranges (see below) and labels them `[SIMULATED]`.

## Today card: "My usual trip"

The app can look after Arjun's commute before he thinks to open the planner. Choose From and To in the planner, open the card at the top (**Set up**), then save:

- **Usual departure time** (e.g. 08:00) and **flexibility** (not flexible, or up to 15 / 30 / 45 / 60 minutes later).
- **Stored in this browser's `localStorage` only** (key `tranzip:usualTrip`). The server never saves it, and the card says so. Its coordinates are sent to the server on each check, only to plan, and are not kept. If your browser blocks storage the trip lasts for the session only, and the card warns you.

On every app open (and every 5 minutes while it stays open, and when you return to the tab after a couple of minutes away) the card asks the server what to do today. It shows one line, and **only becomes prominent when the advice differs from simply taking your usual trip**:

| Situation | Line shown | Prominent? |
|---|---|---|
| Normal day | "Your usual 08:00 looks fine: seats likely." | No (a quiet line with a "Why?" disclosure) |
| A later time in your window is in a quieter crowd band | "Leave 08:30 instead: quieter (standing → seats), +2 min." | **Yes** |
| A live disruption runs through your usual route | "NEL disrupted. Take Bus 666 + EWL + CCL now, +11 min." | **Yes** |
| Busy, but nothing quieter in your window / no crowd data / window already over | Says so plainly ("looks busy…", "no live crowd data…", "today's window has passed") | No |

Prominent advice shows its reason and a **Show route** button, which plans that departure time in the planner and selects the route the advice named. Any `[SIMULATED]` disruption (the demo switch) is labelled `[SIMULATED]` in the line, the reason and any notification.

**How it's computed** (`server/lib/journeyWindow.js`, endpoint `POST /api/journey/window`):

1. Candidate departures are your usual time, then every 15 minutes up to your flexibility, **at most 5**. If your usual time has already passed today it becomes "leave now"; later times that have passed are dropped, and times within 5 minutes of the first add nothing. If the whole window is over, there is no advice (LTA's crowd forecast only covers the rest of today, so tomorrow can't be checked).
2. For each, the server plans the recommended route exactly as the planner does, with your 10% tolerance (one TRANSIT routing query each). Crowding for departures **more than 15 minutes ahead comes from LTA's `/PCDForecast`**; sooner ones use the live `/PCDRealTime` reading. LTA publishes no bus-load forecast, so a bus leg for a future departure is reported as "no data" rather than guessed.
3. **Disruption first:** if a live alert affects your usual route, the advice is the recommended detour, with "+N min" measured against your usual (undisrupted) route.
4. **Otherwise crowding:** "quieter" means a strictly better crowd band (seats < standing < limited standing) than your usual time, never a route that runs through a disruption. The quietest band wins, earliest time on a tie. The "+N min" is the difference in *trip time* (typical duration); the reason also states when you would arrive, since leaving later arrives later.
5. **Bounded upstream use:** the result is cached for 45 seconds (`CACHE_TTL_WINDOW_MS`, keyed by trip, time, flexibility and the demo switch); the endpoint is rate-limited per client (12/minute); and every request has a hard budget of **40 real upstream calls** (LTA/OneMap/Google/NEA — cache hits don't count). If the budget runs out, remaining lookups degrade to "no live data" and the response says `truncated: true`. A typical Punggol → one-north check uses about 15.

**Notifications — honest limits.** There is **no background push**: TranZip has no service worker or push server, so it cannot reach you when the app isn't open. If your browser supports the Notification API, the card offers an *optional* opt-in ("Notify me on this tab when the advice changes"). It fires a browser notification only while the page is open in a background tab, at most once per distinct piece of advice, and never when the page is already on screen. Close the tab or the browser and you will hear nothing. Some mobile browsers don't allow page-created notifications at all; the card still shows the advice.

## No signal underground: offline behaviour

The brief's "no signal underground" note is a real constraint for Arjun: the Punggol → one-north commute goes through tunnels. TranZip's answer is a deliberate, narrow one: **it opens without signal, shows the last journey it planned, and is honest that the journey is out of date. It never replays old live data as if it were live.** It does not try to be a full offline planner (routing needs LTA/OneMap), and it doesn't pretend to be.

**What is saved.** After every successful plan, the *recommended* journey is written to this browser's `localStorage` (key `tranzip:savedJourney`): its legs, clock times, duration ranges, the crowd readings it was ranked on, the origin/destination (name and coordinates), and the timestamp (the device's clock when the plan arrived). Each leg's map line is thinned to at most 60 points to keep it small (about 16 KB for a typical trip); if storage is nearly full it retries without map lines. It is overwritten by the next plan, never sent to the server, and can be removed with **Clear saved copy** under the results. Blocked or full storage never breaks the app.

**How "no signal" is detected.** Two signals, either is enough:

1. `navigator.onLine === false` (the device knows it has no connection), and the browser's `offline` / `online` events.
2. A **failed request** to the TranZip server. `navigator.onLine === true` isn't proof of a connection (a phone on a platform can have a Wi-Fi link and no data), so a request that can't connect also counts. Any request that gets a response, even an error status, proves the server was reached.

Once offline, a cheap health check runs every 15 seconds and on the `online` event; the first request that gets through clears the state. When signal returns, the frozen data (alerts, weather, the Today card) reloads and the journey on screen is re-planned automatically.

**What you see with no signal.**

- A **persistent banner** (it can't be dismissed): "Saved at 08:12. No signal, so this may be out of date." (with the date if it's not from today). If nothing has been saved yet it says so.
- The saved journey opens straight away in the results, with its route drawn on the map. The header shows "Offline" instead of the developer status pills.
- **Live data is never presented as live.** Crowd-level badges turn from a filled coloured chip into a grey, dashed-outline chip with a hollow dot and a text label of their age ("14 min old"); they're greyed rather than faded so the text stays above the 4.5:1 contrast floor, and they change shape and wording, so it never relies on colour alone. Bus arrival "5′" countdowns, which stop being true immediately, become the clock time the bus was due. The route's crowd summary is prefixed "Not live, as of 08:12 (14 min old)", and a "Not live" note sits above the results. The MRT alerts banner and the weather chip are hidden (they'd read as current), and the Today card says it can't check.
- Data also counts as stale **while online** once it is **more than 10 minutes old** (LTA's crowd readings are 10-minute windows). The same dimming and age labels apply, with a **Refresh** button. Labels tick every 30 seconds.

**The service worker** (`public/sw.js`, registered only in production builds) caches the *app shell*: the page, its hashed JS and CSS, the icon and the manifest, so the page opens with no signal. It deliberately does **not** cache `/api/*` (live data must never come from a cache) and does not handle cross-origin requests, so **map tiles are not cached: the map is blank offline, but the route, its steps and the crowd information are still there.** Page loads use the network when it answers within 4 seconds and fall back to the cached shell otherwise, so a bad connection doesn't leave you waiting on a spinner. Each `vite build` stamps the worker with a new cache name, so a deploy is picked up and old caches are deleted.

**Limits, stated plainly.**

- The first visit needs signal: the worker installs on a successful load, and the app isn't available offline before that.
- It only shows the *last* journey planned on this device. It can't plan a new one, check today's conditions or re-rank routes without signal.
- The saved journey can be old (it says how old). A route planned yesterday may no longer run.
- Service workers need HTTPS (or `localhost`); on plain `http://` elsewhere the app works online-only. They aren't registered under `npm run dev`; use `npm run build && npm start` to try them.
- Browsers may evict `localStorage` (Safari clears it after a week of non-use). The app then simply has nothing saved.

**Trying it.** `npm run build && npm start`, open `http://localhost:8787`, plan a journey, then either stop the server, or use DevTools → Network → **Offline**. Reload: the app opens, the banner shows, and the saved journey is listed with dimmed, age-labelled crowd badges. Restart the server (or untick Offline) and it recovers by itself within about 15 seconds.

## Data sources & licences

| Source | Used for | Licence |
|---|---|---|
| [LTA DataMall](https://datamall.lta.gov.sg) | Bus arrivals + load, MRT/LRT platform crowd, service alerts, bus routes/stops/services reference data | [Singapore Open Data Licence](https://data.gov.sg/open-data-licence) |
| [NEA via data.gov.sg](https://data.gov.sg) | Real-time rainfall, air temperature, 2-hour weather forecast | [Singapore Open Data Licence](https://data.gov.sg/open-data-licence) |
| [OneMap](https://www.onemap.gov.sg) (Singapore Land Authority) | Place search, reverse geocoding, optional routing, map click-to-pin | OneMap API terms — attribution required, shown in the footer and (for the basemap, historically) the map |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | Basemap tiles (`tile.openstreetmap.org`) | Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Tiles are served by the OpenStreetMap Foundation under its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/): light use only, attribution required (shown on the map), no bulk downloading or pre-fetching, no uptime guarantee. That is fine for a demo; for real traffic switch `VITE_TILE_URL` to another OSM-based provider. |
| [Google Maps Routes API](https://developers.google.com/maps/documentation/routes) (optional) | Primary transit routing, when a key is configured | Google Maps Platform Terms of Service (commercial, not open data) |

Every source is credited in the app footer and in the map's attribution control.

## Privacy: what's stored, where, for how long

TranZip has **no user accounts, no database, and no analytics or trackers**.

- **Your journey (origin, destination, chosen options) never leaves your browser except as part of a live API request.** It's sent to the TranZip server, which forwards the relevant parts to LTA/OneMap/Google/NEA to compute the answer, and returns it. Nothing about the journey is written to disk or a database.
- **Server-side caching is in-memory only**, keyed by request parameters (e.g. a bus stop code, a station line), with short TTLs (20 seconds to 24 hours depending on how often the underlying data changes — see `CACHE_TTL_*` in `.env.example`). It exists purely to avoid hammering upstream APIs, is cleared whenever the server restarts, and is never written to disk.
- **Two things *are* written to disk**, and neither contains anything about you or your journeys: `server/data/stations.json` (a static MRT/LRT station reference catalogue built ahead of time) and `.cache/bus-network.json.gz` (a snapshot of LTA's public bus-route topology, rebuilt periodically, so the server doesn't re-fetch ~27,000 rows on every restart).
- **"Use my location"** sends your coordinates to the server once, for a single reverse-geocode lookup (via OneMap) to turn them into a place name. The coordinates aren't stored server-side beyond that one request/response.
- **The browser stores four things in `localStorage`, all on your device only:** the "A+" large-text toggle (`tranzip:largeText`), your **usual trip** if you save one (`tranzip:usualTrip`: two places' names and coordinates, a departure time and a flexibility), your notification opt-in (`tranzip:notify`), and your **last planned journey** for offline use (`tranzip:savedJourney`: its legs, times, crowd readings and the origin/destination, overwritten by each plan; clear it with "Clear saved copy"). The service worker's cache holds only the app's own files, never journey or live data. There are no cookies and no `sessionStorage`, and nothing else about your journeys is saved — refreshing the page clears all other app state. The server never stores your usual trip; the "Today" check sends its coordinates for planning only, and the result is cached in server memory for 45 seconds.
- **Secrets never reach the browser.** `LTA_ACCOUNT_KEY`, `ONEMAP_TOKEN`/`ONEMAP_EMAIL`/`ONEMAP_PASSWORD`, and `GOOGLE_MAPS_API_KEY` live only in the server's `.env` and are attached to outbound API calls server-side. The only environment values shipped to the browser are the `VITE_TILE_URL`/`VITE_TILE_ATTRIBUTION` basemap settings, which are public tile-service URLs, not credentials.

## Limitations

- **Overnight service gaps are real, not bugs.** LTA's live bus arrival feed genuinely returns no data roughly 00:30–05:30 SGT, when most bus services aren't running — TranZip reports "no live data" accurately rather than fabricating an arrival time.
- **OneMap's routing service can be intermittently unavailable** (observed during development, not something TranZip controls). The app falls back to its own LTA-native planner automatically, but that fallback's times are model-based estimates, not live transit data (see below).
- **Fare estimates are a distance-banded approximation**, not the actual concession/fare-card price — see the calculation table below.
- **"Avoid weather" reduces time spent walking; it doesn't route along literal sheltered walkways.** No public dataset of Singapore's covered linkways was confirmed available during development, so this is a walking-time heuristic, not true shelter-aware pathfinding.
- **The "hot" threshold is a simple fixed 32°C cutoff**, not a humidity-adjusted heat index.
- **Offline, only the last planned journey is available**, and the map tiles aren't cached: see [No signal underground](#no-signal-underground-offline-behaviour).
- **There is no background push.** The "Today" card and its optional browser notification only work while the app is open in a tab; TranZip has no service worker or push server, so it can't warn you when it isn't running.
- **"Today" advice covers the rest of today only, and assumes Singapore time.** LTA's crowd forecast doesn't reach tomorrow, so once your usual window has passed there's nothing to advise; times are shown in Singapore time, so a device on another timezone will see its saved "08:00" interpreted in that timezone but displayed in Singapore's.
- **Bus load isn't forecast.** LTA publishes a crowd forecast for MRT/LRT stations but not for buses, so for any departure more than 15 minutes ahead a bus leg has no load data (rail legs still do), and the advice leans on rail crowding.
- **Disruption and weather data reflect the current moment (or the simulated override)** — there's no historical or predictive model beyond LTA's own 30-minute crowd forecast.
- **In-memory caching is per-process.** Fine for a single-instance demo; wouldn't share state across multiple server instances without an external cache.
- **Automated tests cover deterministic logic only, and never touch the network** (`npm test`): load-band math and journey weighting, ranking (tolerance, disruption avoidance, weather, ties), disruption parsing (`normaliseSegment`), rail pathfinding and rerouting, travel-time ranges, "Today" advice and its call budget, and the browser-side storage and staleness rules. A preloaded guard (`server/tests/no-network.setup.js`) makes any `fetch` throw, so a test that reaches for LTA, OneMap, Google or NEA fails instead of quietly spending quota. There's no automated browser/E2E suite in the repo; UI behaviour is verified manually.

## How every number in the UI is calculated

| What you see | How it's computed |
|---|---|
| **Route duration range** ("28–35 min", labelled *estimate*) | The min/max of a per-leg heuristic, summed. See [Travel-time ranges](#travel-time-ranges-heuristics-not-predictions) below. |
| **Route duration** (typical figure behind the range; used for ranking) | From the routing engine directly when Google or OneMap is the source. From TranZip's own local planner: sum of each leg's ride time + wait time + a fixed interchange penalty. Bus ride time = distance ÷ 18 km/h + 0.35 min dwell per intermediate stop; bus wait = half the published peak headway (clamped 2.5–12 min). Rail ride time = distance ÷ commercial speed (13 m/s MRT, 9.5 m/s LRT, both already include dwell); interchanges add a flat 4.5 min. Walk time = straight-line distance × 1.25 (street-vs-as-the-crow-flies factor) ÷ 1.25 m/s + 1 min overhead. See `server/lib/localPlanner.js`. |
| **Passenger load band** (Seats / Standing / Limited standing) | Bus: LTA's live `Load` code on the first matching arrival you can still catch (`SEA`→seats, `SDA`→standing, `LSD`→limited); for a departure more than 15 minutes ahead with no catchable arrival listed, it's "no data" (LTA has no bus-load forecast). MRT/LRT: LTA's live `CrowdLevel` per station (`l`/`m`/`h`) for stations within the live 10-minute window, or the 30-minute forecast bin for departures more than 15 minutes out. See `server/lib/loadModel.js` and `enrichBusLeg`/`enrichRailLeg` in `server/lib/journeyPlanner.js`. |
| **Route-level load score** (0–1, drives ranking) | Each in-vehicle leg's band maps to a score (seats=0.2, standing=0.6, limited=0.9); the route's score is the average of its legs' scores, weighted by each leg's ride duration, so a short crowded hop can't outweigh a long comfortable one. Legs with no live data are excluded, not scored as bad. `journeyLoadScore` in `server/lib/loadModel.js`. |
| **"Recommended" pick** | Of all routes within your chosen tolerance (5/10/20%) of the fastest route's time, the one with the lowest load score wins; a route with no load data is treated as neutral (0.5), never automatically "best". If a live disruption is active, disrupted routes are excluded from this comparison entirely whenever an unaffected route exists. `rankRoutes` in `server/lib/journeyPlanner.js`. |
| **Weather-adjusted ranking** | Only applied when you enable "avoid weather" and it's actually raining/hot. Each route's rank score becomes a 50/50 blend of its load score and its share of trip time spent walking, so less time on foot can outweigh a busier vehicle. `rankRoutes`, `weatherActive` branch. |
| **Today card advice** ("Leave 08:30 instead: quieter (standing → seats), +2 min") | The recommended route planned at up to 5 departure times, 15 minutes apart; "quieter" = a strictly better load band than your usual time; "+N min" = difference in typical trip time. For a disruption, "+N min" is the detour's duration minus your usual route's. See [Today card](#today-card-my-usual-trip). `buildAdvice` in `server/lib/journeyWindow.js`. |
| **Fare estimate** | A fixed distance-to-fare lookup table approximating an adult card fare (`FARE_BANDS` in `server/lib/localPlanner.js`) — a rough guide, not an authoritative TransitLink/SimplyGo quote. Not shown at all for Google/OneMap-sourced routes (they don't return fare data). |
| **Crowd forecast timeline** | LTA's `/PCDForecast` 30-minute interval bins for the rest of the operating day, shown for the station/line you're viewing. |
| **"Raining now" / "Hot now"** | Live: nearest NEA rainfall station's 5-minute reading ≥ 0.2 mm counts as raining, or the 2-hour forecast text for the nearest forecast area contains a rain-related word (rain/shower/thunder/drizzle). Temperature ≥ 32°C at the nearest station counts as hot. `getWeatherNear` in `server/lib/weatherClient.js`. |
| **Disruption / rerouting** | LTA's `/TrainServiceAlerts` reports `Status: 2` (active disruption) with a list of affected station codes. TranZip treats those stations as unreachable in its own rail-network graph (`findRailPath` in `server/lib/railNetwork.js`) and re-searches for a path around them, rather than just flagging the original route. |
| **Walk distance/time on the map & in step details** | Straight-line (haversine) distance between two points × 1.25 detour factor; time from that distance at an assumed 1.25 m/s (~4.5 km/h) walking pace. |

### Travel-time ranges (heuristics, not predictions)

Every route and every leg shows a range such as **"28–35 min"**, always labelled *estimate*. The server returns `{ minMinutes, maxMinutes, typicalMinutes }` for each leg and for the route (`durationRange`, computed in `server/lib/durationRange.js`). The rules are deliberately simple round numbers. **They are heuristics chosen for plausibility, not calibrated or fitted to data, and they are not a statistical prediction interval.** Change them in `RANGE_RULES` in that file.

| Leg | Range rule |
|---|---|
| **Walk** | Planner's walk time **±10%**. If it is raining near the origin, the *top end* grows by a further 15% of the walk time (so up to +25%). |
| **Bus** | *Waiting* + *in-vehicle*. **Wait:** from the next 2–3 LTA `BusArrival` estimates (`NextBus`, `NextBus2`, `NextBus3`) that arrive after you would reach the stop, the minimum is the soonest and the maximum is the latest (so it covers missing a bus or two). **In-vehicle:** the planner's ride time **±10%**. The typical figure uses the soonest catchable bus. If there are no usable live arrivals (unmonitored service, overnight, or the trip starts more than 15 minutes from now), the wait is left at the planner's figure and **not** widened. LTA's road speed bands would widen the ride time when traffic is slow, but TranZip does not fetch them, so that rule is not applied. |
| **MRT / LRT** | If the *boarding* platform's live crowd level is `h` (high), **+0 to +3 minutes** for possibly missing a full train (the 3 is one train interval, matching the wait the fallback planner assumes for rail). Otherwise, or if the crowd level is unknown, the ride time **±5%**. The planner's wait is not widened. |
| **Route** | The sum of its legs' ranges, plus any waiting the routing source counted in its total that isn't attributed to a leg. With no live data at all, `typicalMinutes` equals the planner's own duration exactly. |

Limits worth knowing:

- Figures are rounded to whole minutes, so a short leg (e.g. a 3-minute walk) collapses to a single value instead of showing a made-up range.
- Live bus arrivals can move `typicalMinutes` away from the planner's duration (for example, a bus that is 20 minutes away when the planner assumed a 3-minute wait). The range then reflects the live wait, while **ranking, the recommendation reason and the "vs usual" delta chip still use the planner's single duration.**
- Rain is read once, near the origin, and applied to every walking leg of the trip. It is read whether or not "avoid weather" is on. If the rain is the simulated weather override, the widened walk ranges are labelled `[SIMULATED]`.

## Project structure

```
src/            React 18 + Vite frontend (Leaflet map, planner form, route/leg views, offline + stale-data handling)
public/         Static files copied into the build as-is: manifest, icon, and sw.js (the app-shell service worker)
server/         Node/Express API proxy - all third-party keys live here, never in the browser
server/lib/     Routing, load-scoring, disruption/weather logic, and the LTA/OneMap/Google clients
server/data/    Static reference data (station catalogue) + the dev-only simulation fixtures
server/tests/   node:test suite for the deterministic server-side logic, plus its no-network guard (npm test)
scripts/        One-off build scripts (e.g. regenerating the station catalogue)
```
