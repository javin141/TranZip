# Today card: "My usual trip"

[← Back to the README](../README.md)

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

**Notifications — honest limits.** There is **no background push**: TranZip has no push server, and its service worker only caches the app shell (see [offline behaviour](offline.md)), so nothing can reach you when the app isn't open. If your browser supports the Notification API, the card offers an *optional* opt-in ("Notify me on this tab when the advice changes"). It fires a browser notification only while the page is open in a background tab, at most once per distinct piece of advice, and never when the page is already on screen. Close the tab or the browser and you will hear nothing. Some mobile browsers don't allow page-created notifications at all; the card still shows the advice.
