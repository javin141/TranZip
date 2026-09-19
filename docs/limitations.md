# Limitations

[← Back to the README](../README.md)

- **Overnight service gaps are real, not bugs.** LTA's live bus arrival feed genuinely returns no data roughly 00:30–05:30 SGT, when most bus services aren't running — TranZip reports "no live data" accurately rather than fabricating an arrival time.
- **OneMap's routing service can be intermittently unavailable** (observed during development, not something TranZip controls). The app falls back to its own LTA-native planner automatically, but that fallback's times are model-based estimates, not live transit data (see [how it works](how-it-works.md)).
- **Fare estimates are a distance-banded approximation**, not the actual concession/fare-card price, and only appear for routes from the fallback planner.
- **"Avoid weather" reduces time spent walking; it doesn't route along literal sheltered walkways.** No public dataset of Singapore's covered linkways was confirmed available during development, so this is a walking-time heuristic, not true shelter-aware pathfinding.
- **The "hot" threshold is a simple fixed 32°C cutoff**, not a humidity-adjusted heat index.
- **Offline, only the last planned journey is available**, and the map tiles aren't cached: see [No signal underground](offline.md).
- **There is no background push.** The "Today" card and its optional browser notification only work while the app is open in a tab; TranZip has no push server (its service worker only caches the app shell), so it can't warn you when it isn't running.
- **"Today" advice covers the rest of today only, and assumes Singapore time.** LTA's crowd forecast doesn't reach tomorrow, so once your usual window has passed there's nothing to advise; times are shown in Singapore time, so a device on another timezone will see its saved "08:00" interpreted in that timezone but displayed in Singapore's.
- **Bus load isn't forecast.** LTA publishes a crowd forecast for MRT/LRT stations but not for buses, so for any departure more than 15 minutes ahead a bus leg has no load data (rail legs still do), and the advice leans on rail crowding.
- **Disruption and weather data reflect the current moment (or the simulated override)** — there's no historical or predictive model beyond LTA's own 30-minute crowd forecast.
- **In-memory state is per-process.** Server caches, and the demo disruption switch, live in one server process's memory: fine for a single-instance demo, but not shared across several instances (on Vercel's serverless functions the demo switch can appear to flip back).
- **The basemap is OpenStreetMap's own tile server**, which is for light use only and has no uptime guarantee; switch `VITE_TILE_URL` to another OSM-based provider for real traffic.
- **Automated tests cover deterministic logic only, and never touch the network** (`npm test`): load-band math and journey weighting, ranking (tolerance, disruption avoidance, weather, ties), disruption parsing (`normaliseSegment`), rail pathfinding and rerouting, travel-time ranges, leg-time inference, "Today" advice and its call budget, and the browser-side storage and staleness rules. A preloaded guard (`server/tests/no-network.setup.js`) makes any `fetch` throw, so a test that reaches for LTA, OneMap, Google or NEA fails instead of quietly spending quota. There's no automated browser/E2E suite in the repo; UI behaviour is verified manually.
