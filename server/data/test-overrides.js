/**
 * DEV/TEST ONLY - fixture content for features that are normally driven by
 * real-world events (a train disruption, rain), so they can be demoed
 * without waiting for the real thing to happen. Every simulated response is
 * clearly marked ("SIMULATED" source field, "[SIMULATED]" prefix wherever it
 * surfaces in the UI) so it can never be mistaken for the real thing.
 */

/**
 * server/lib/disruptions.js - the fake LTA `/TrainServiceAlerts` segment
 * used when the demo disruption toggle is on (see below; DEMO_MODE=1 in
 * .env gates the toggle, and it's a runtime switch in the UI now, not a
 * flag you hand-edit here and restart the server for - see
 * getDemoDisruptionActive/setDemoDisruptionActive in disruptions.js).
 *
 * Fields (mirroring LTA's real /TrainServiceAlerts shape):
 *   Line              - one of NSL, EWL, CGL, NEL, CCL, CEL, DTL, TEL, BPL,
 *                        SLRT, PLRT (server/lib/railLines.js has the full list)
 *   Stations          - comma-separated station codes for the affected stretch.
 *                        Look up real codes in server/lib/railNetwork.js
 *                        (LINE_CHAINS) or by calling GET /api/loads/lines/<LINE>.
 *   Direction         - free text, shown in the UI note (optional).
 *   FreePublicBus     - comma-separated station codes where a free bus
 *                        bridges the gap, or the literal string "Free bus
 *                        service island wide" for a system-wide free bus.
 *   FreeMRTShuttle    - comma-separated station codes served by a free MRT
 *                        shuttle train, same "island wide" option.
 *   MRTShuttleDirection - free text describing the shuttle's direction.
 *
 * Try it (matches the demo journey - Punggol to one-north): the default
 * below blocks the North East Line between Punggol and Serangoon (Hougang -
 * Buangkok - Sengkang), which is the exact stretch that trip's fastest route
 * rides before transferring to the Circle Line, with a free shuttle bus
 * offered at Hougang. Set DEMO_MODE=1 in .env, restart the server, then use
 * the "Demo: simulate NEL disruption" switch in the app - plan Punggol ->
 * one-north and the route should detour (via a bus + another line) instead
 * of riding through the blocked stretch, with "Service alert" / "Rerouted"
 * ribbons and a "Free bus available at Hougang" note on the affected cards.
 */
export const demoDisruptionFixture = {
  segments: [
    {
      Line: 'NEL',
      Direction: 'Towards HarbourFront',
      Stations: 'NE14,NE15,NE16',
      FreePublicBus: 'NE14',
      FreeMRTShuttle: '',
      MRTShuttleDirection: '',
    },
  ],
  messages: [
    {
      content: 'Free bus service is available at Hougang while this disruption is in effect.',
      createdDate: new Date().toISOString(),
    },
  ],
};

/**
 * server/lib/weatherClient.js - simulates a live NEA weather reading, so the
 * weather-aware ranking bias (journeyPlanner's `avoidWeather` option)
 * actually triggers.
 *
 * Fields:
 *   condition    - 'rain' | 'hot' | 'clear'
 *   rainfallMm   - shown as the live rainfall reading (only matters for 'rain')
 *   temperatureC - shown as the live temperature reading (only matters for 'hot';
 *                  'hot' triggers automatically once this is >= 32)
 *   forecastText - shown as the 2-hour forecast text, e.g. "Heavy Thundery Showers"
 *
 * Try it: the default below simulates moderate rain. Turn on "avoid weather"
 * in the planner (or just plan a journey - the toggle appears automatically
 * once this is active) and walk-heavy routes should lose to bus/rail-heavy
 * ones, with a rain note on the recommended route card.
 */
export const weatherOverride = {
  active: false,
  condition: 'rain',
  rainfallMm: 4.5,
  temperatureC: 28,
  forecastText: 'Moderate Rain',
};
