# No signal underground: offline behaviour

[← Back to the README](../README.md)

The brief's "no signal underground" note is a real constraint for Arjun: the Punggol → one-north commute goes through tunnels. TranZip's answer is a deliberate, narrow one: **it opens without signal, shows the last journey it planned, and is honest that the journey is out of date. It never replays old live data as if it were live.** It does not try to be a full offline planner (routing needs LTA/OneMap), and it doesn't pretend to be.

**What is saved.** After every successful plan, the *recommended* journey is written to this browser's `localStorage` (key `tranzip:savedJourney`): its legs, clock times, duration ranges, the crowd readings it was ranked on, the origin/destination (name and coordinates), and the timestamp (the device's clock when the plan arrived). Each leg's map line is thinned to at most 60 points to keep it small (about 16 KB for a typical trip); if storage is nearly full it retries without map lines. It is overwritten by the next plan, never sent to the server, and can be removed with **Clear saved copy** under the results. Blocked or full storage never breaks the app.

**How "no signal" is detected.** Two signals, either is enough:

1. `navigator.onLine === false` (the device knows it has no connection), and the browser's `offline` / `online` events.
2. A **failed request** to the TranZip server. `navigator.onLine === true` isn't proof of a connection (a phone on a platform can have a Wi-Fi link and no data), so a request that can't connect also counts. Any request that gets a response, even an error status, proves the server was reached.

Once offline, a cheap health check runs every 15 seconds and on the `online` event; the first request that gets through clears the state. When signal returns, the frozen data (alerts, weather, the Today card) reloads and the journey on screen is re-planned automatically.

**What you see with no signal.**

- A **persistent banner** (it can't be dismissed): "Saved at 08:12. No signal, so this may be out of date." (with the date if it's not from today). If nothing has been saved yet it says so.
- The saved journey opens straight away in the results, with its route drawn on the map. The header shows "Offline" instead of the developer status pills.
- **Live data is never presented as live.** Crowd-level badges turn from a filled coloured chip into a grey, dashed-outline chip with a hollow dot and a text label of their age ("14 min old"). Bus arrival "5′" countdowns, which stop being true immediately, become the clock time the bus was due. The route's crowd summary is prefixed "Not live, as of 08:12 (14 min old)", and a "Not live" note sits above the results. The MRT alerts banner and the weather chip are hidden (they'd read as current), and the Today card says it can't check.
- Data also counts as stale **while online** once it is **more than 10 minutes old** (LTA's crowd readings are 10-minute windows). The same dimming and age labels apply, with a **Refresh** button. Labels tick every 30 seconds.

**The service worker** (`public/sw.js`, registered only in production builds) caches the *app shell*: the page, its hashed JS and CSS, the icon and the manifest, so the page opens with no signal. It deliberately does **not** cache `/api/*` (live data must never come from a cache) and does not handle cross-origin requests, so **map tiles are not cached: the map is blank offline, but the route, its steps and the crowd information are still there.** Page loads use the network when it answers within 4 seconds and fall back to the cached shell otherwise, so a bad connection doesn't leave you waiting on a spinner. Each `vite build` stamps the worker with a new cache name, so a deploy is picked up and old caches are deleted.

**Limits, stated plainly.**

- The first visit needs signal: the worker installs on a successful load, and the app isn't available offline before that.
- It only shows the *last* journey planned on this device. It can't plan a new one, check today's conditions or re-rank routes without signal.
- The saved journey can be old (it says how old). A route planned yesterday may no longer run.
