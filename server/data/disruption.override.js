/**
 * DEV/TEST ONLY - hardcode a fake LTA service alert here to see the
 * disruption-aware rerouting (server/lib/disruptions.js) actually trigger,
 * without waiting for a real MRT disruption.
 *
 * How it works: when `active` is `true`, every journey-planning request uses
 * THIS object instead of calling the real LTA `/TrainServiceAlerts`
 * endpoint. The app clearly marks routes as "SIMULATED" in the warning
 * banner and console so it can never be mistaken for a real live alert.
 *
 * Set `active` back to `false` when you're done testing - this file is
 * checked before every request, so leaving it on affects the whole app.
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
        + 'Set active:false in server/data/disruption.override.js to turn this off.',
      createdDate: new Date().toISOString(),
    },
  ],
};
