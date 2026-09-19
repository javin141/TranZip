# How every number in the UI is calculated

[← Back to the README](../README.md)

| What you see | How it's computed |
|---|---|
| **Route duration range** ("28–35 min", labelled *estimate*) | The min/max of a per-leg heuristic, summed. See [Travel-time ranges](#travel-time-ranges-heuristics-not-predictions) below. |
| **Route duration** (typical figure behind the range; used for ranking) | From the routing engine directly when Google or OneMap is the source. From TranZip's own local planner: sum of each leg's ride time + wait time + a fixed interchange penalty. Bus ride time = distance ÷ 18 km/h + 0.35 min dwell per intermediate stop; bus wait = half the published peak headway (clamped 2.5–12 min). Rail ride time = distance ÷ commercial speed (13 m/s MRT, 9.5 m/s LRT, both already include dwell); interchanges add a flat 4.5 min. Walk time = straight-line distance × 1.25 (street-vs-as-the-crow-flies factor) ÷ 1.25 m/s + 1 min overhead. See `server/lib/localPlanner.js`. |
| **Passenger load band** (Seats / Standing / Limited standing) | Bus: LTA's live `Load` code on the first matching arrival you can still catch (`SEA`→seats, `SDA`→standing, `LSD`→limited); for a departure more than 15 minutes ahead with no catchable arrival listed, it's "no data" (LTA has no bus-load forecast). MRT/LRT: LTA's live `CrowdLevel` per station (`l`/`m`/`h`) for stations within the live 10-minute window, or the 30-minute forecast bin for departures more than 15 minutes out. See `server/lib/loadModel.js` and `enrichBusLeg`/`enrichRailLeg` in `server/lib/journeyPlanner.js`. |
| **Route-level load score** (0–1, drives ranking) | Each in-vehicle leg's band maps to a score (seats=0.2, standing=0.6, limited=0.9); the route's score is the average of its legs' scores, weighted by each leg's ride duration, so a short crowded hop can't outweigh a long comfortable one. Legs with no live data are excluded, not scored as bad. `journeyLoadScore` in `server/lib/loadModel.js`. |
| **"Recommended" pick** | Of all routes within your chosen tolerance (5/10/20%) of the fastest route's time, the one with the lowest load score wins; a route with no load data is treated as neutral (0.5), never automatically "best". If a live disruption is active, disrupted routes are excluded from this comparison entirely whenever an unaffected route exists. `rankRoutes` in `server/lib/journeyPlanner.js`. |
| **Weather-adjusted ranking** | Only applied when you enable "avoid weather" and it's actually raining/hot. Each route's rank score becomes a 50/50 blend of its load score and its share of trip time spent walking, so less time on foot can outweigh a busier vehicle. `rankRoutes`, `weatherActive` branch. |
| **Today card advice** ("Leave 08:30 instead: quieter (standing → seats), +2 min") | The recommended route planned at up to 5 departure times, 15 minutes apart; "quieter" = a strictly better load band than your usual time; "+N min" = difference in typical trip time. For a disruption, "+N min" is the detour's duration minus your usual route's. See [Today card](today-card.md). `buildAdvice` in `server/lib/journeyWindow.js`. |
| **Fare estimate** | A fixed distance-to-fare lookup table approximating an adult card fare (`FARE_BANDS` in `server/lib/localPlanner.js`) — a rough guide, not an authoritative TransitLink/SimplyGo quote. Not shown at all for Google/OneMap-sourced routes (they don't return fare data). |
| **Crowd forecast timeline** | LTA's `/PCDForecast` 30-minute interval bins for the rest of the operating day, shown for the station/line you're viewing. |
| **"Raining now" / "Hot now"** | Live: nearest NEA rainfall station's 5-minute reading ≥ 0.2 mm counts as raining, or the 2-hour forecast text for the nearest forecast area contains a rain-related word (rain/shower/thunder/drizzle). Temperature ≥ 32°C at the nearest station counts as hot. `getWeatherNear` in `server/lib/weatherClient.js`. |
| **Disruption / rerouting** | LTA's `/TrainServiceAlerts` reports `Status: 2` (active disruption) with a list of affected station codes. TranZip treats those stations as unreachable in its own rail-network graph (`findRailPath` in `server/lib/railNetwork.js`) and re-searches for a path around them, rather than just flagging the original route. |
| **Walk distance/time on the map & in step details** | Straight-line (haversine) distance between two points × 1.25 detour factor; time from that distance at an assumed 1.25 m/s (~4.5 km/h) walking pace. (Google and OneMap supply their own walking figures instead.) |
| **Clock times on walking steps** (shown as `~13:16 – ~13:17`) | Derived from the neighbouring legs and the walk's own duration when the routing source gives no time for a walk. See [Walking step times](#walking-step-times). `inferLegTimes` in `server/lib/legTimes.js`. |
| **The "Walk" bubble's hover text** ("Walking · 15 min · 949 m") | The sum of the durations and distances of every walking leg in that unbroken stretch. |

## Travel-time ranges (heuristics, not predictions)

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

## Walking step times

Google's Routes API gives real departure and arrival times for train and bus legs but none for the walks between them, so those steps had no time to show. TranZip fills them in from what *is* known (`server/lib/legTimes.js`):

- A walk after a ride starts when that ride arrives and lasts its own duration; consecutive walks ("walk, take entrance B, walk") follow one another.
- A walk before a ride is worked backwards from that ride's departure, so you leave early enough.
- A walk is never made to end after the next leg has already left. Any gap before the next ride is real waiting and shows as a gap between the two times.
- A walk-only route starts at the departure time you asked for. If nothing can anchor a leg, its clock is hidden rather than invented.

Every time derived this way is flagged (`timesInferred`) and shown with a "~" and a tooltip saying it is estimated. Times the routing source supplied are never changed. The route's overall start and end times are widened to include a leading or trailing walk.

On the route card, each unbroken stretch of walking is one "Walk" bubble however many turns it has; its hover text totals the durations and distances of the walking legs in it (for example "Walking · 15 min · 949 m"). The step-by-step list still shows every instruction.
