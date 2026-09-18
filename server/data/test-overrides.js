/**
 * DEV/TEST ONLY - hardcode fake live conditions here to exercise features
 * that are normally driven by real-world events (a train disruption, rain)
 * without waiting for the real thing to happen. Each override below has its
 * own `active` flag and can be toggled independently - turn on just one, or
 * both at once to see disruption rerouting and weather-aware ranking
 * interact.
 *
 * Every simulated response is clearly marked ("SIMULATED" source field,
 * "[SIMULATED]" prefix on the in-app warning banner) so it can never be
 * mistaken for the real thing. Restart the server after editing this file -
 * it's read once per request, but Node doesn't hot-reload.
 *
 * Remember to set `active: false` again when you're done testing - these
 * checks run on every request, so leaving one on affects the whole app.
 */

/**
 * server/lib/disruptions.js - simulates a live LTA `/TrainServiceAlerts`
 * segment, so the disruption-aware rerouting actually triggers.
 *
 * Fields:
 *   Line     - one of NSL, EWL, CGL, NEL, CCL, CEL, DTL, TEL, BPL, SLRT, PLRT
 *              (server/lib/railLines.js has the full list)
 *   Stations - comma-separated station codes for the affected stretch.
 *              Look up real codes in server/lib/railNetwork.js (LINE_CHAINS)
 *              or by calling GET /api/loads/lines/<LINE>.
 *   Direction - free text, shown in the UI note (optional).
 *
 * Try it: the default below blocks Orchard/Somerset/Dhoby Ghaut on the
 * North-South Line. Plan a journey that would normally ride through that
 * stretch (e.g. Woodlands to Marina Bay) and the route should reroute via
 * another line, with a "Service alert" / "Rerouted" ribbon on the affected
 * route cards.
 */
export const disruptionOverride = {
  active: false,
  segments: [
    {
      Line: 'NSL',
      Direction: 'Towards Marina South Pier',
      Stations: 'NS22,NS23,NS24',
    },
  ],
  messages: [
    {
      content: 'TEST: simulated disruption on the North-South Line (Orchard - Dhoby Ghaut). '
        + 'Set active:false in server/data/test-overrides.js to turn this off.',
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
