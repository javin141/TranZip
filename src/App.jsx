import { useCallback, useState } from 'react';
import { api } from './api/client.js';
import { MapView } from './components/MapView.jsx';
import { PlannerForm } from './components/PlannerForm.jsx';
import { RouteCard } from './components/RouteCard.jsx';
import { LoadScale } from './components/LoadBadge.jsx';
import { useAsyncResource } from './hooks/useJourney.js';
import { DEFAULT_MODES, DEFAULT_TOLERANCE_PERCENT } from './lib/constants.js';
import { classNames, formatClock, pluralise, relativeTime } from './lib/format.js';

const EXAMPLE_ORIGIN = { latitude: 1.35089, longitude: 103.83905, name: 'Bishan MRT Station' };
const EXAMPLE_DESTINATION = { latitude: 1.27643, longitude: 103.85148, name: 'Marina Bay MRT Station' };

/** Formats a Date for the `datetime-local` input (local time, minutes precision). */
function localDateTimeInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function StatusPill({ ok, label, offlineLabel }) {
  if (ok === undefined) {
    return <span className="status-pill">{`${label} · checking…`}</span>;
  }
  return (
    <span className={classNames('status-pill', ok ? 'status-pill--good' : 'status-pill--warn')}>
      {ok ? `${label} · live` : offlineLabel}
    </span>
  );
}

export function App() {
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [departureMode, setDepartureMode] = useState('now');
  const [departAt, setDepartAt] = useState('');
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE_PERCENT);
  const [modes, setModes] = useState(DEFAULT_MODES);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [expandedRouteId, setExpandedRouteId] = useState(null);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [activeLegId, setActiveLegId] = useState(null);
  const [pickTarget, setPickTarget] = useState(null);
  const [alertsDismissed, setAlertsDismissed] = useState(false);

  const health = useAsyncResource((signal) => api.health(signal), []);
  const alerts = useAsyncResource((signal) => api.serviceAlerts(signal), []);

  const planJourney = useCallback(async (from = origin, to = destination) => {
    if (!from || !to || planning) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const payload = {
        origin: from,
        destination: to,
        tolerance,
        modes,
      };
      if (departureMode === 'schedule' && departAt) {
        payload.departAt = new Date(departAt).toISOString();
      }
      const result = await api.planJourney(payload);
      setPlan(result);
      const recommended = result.routes?.find((route) => route.recommended) || result.routes?.[0] || null;
      setSelectedRouteId(recommended?.id || null);
      setExpandedRouteId(recommended?.id || null);
      setActiveLegId(null);
    } catch (error) {
      setPlan(null);
      setPlanError(error);
    } finally {
      setPlanning(false);
    }
  }, [origin, destination, planning, tolerance, modes, departureMode, departAt]);

  const handleDepartureModeChange = (mode) => {
    setDepartureMode(mode);
    if (mode === 'schedule' && !departAt) {
      setDepartAt(localDateTimeInput(new Date(Date.now() + 10 * 60 * 1000)));
    }
  };

  const handleToggleMode = (mode) => {
    setModes((current) => (
      current.includes(mode)
        ? (current.length > 1 ? current.filter((value) => value !== mode) : current)
        : [...current, mode]
    ));
  };

  const handleSwap = () => {
    setOrigin(destination);
    setDestination(origin);
  };

  // Map click: drop a pin for whichever end is armed, then arm the other end.
  const handlePickPoint = async (point) => {
    const target = pickTarget || 'origin';
    setPickTarget(target === 'origin' ? 'destination' : 'origin');
    const dropped = { latitude: point.latitude, longitude: point.longitude, name: 'Dropped pin', address: '' };
    try {
      const resolved = await api.reverseGeocode(point.latitude, point.longitude);
      if (resolved?.name && resolved.name !== 'Current location') dropped.name = resolved.name;
      dropped.address = resolved?.address || '';
    } catch {
      // Reverse geocoding consumes quota - coordinates alone are fine.
    }
    if (target === 'origin') setOrigin(dropped);
    else setDestination(dropped);
  };

  const runExample = () => {
    setOrigin(EXAMPLE_ORIGIN);
    setDestination(EXAMPLE_DESTINATION);
    planJourney(EXAMPLE_ORIGIN, EXAMPLE_DESTINATION);
  };

  const selectedRoute = plan?.routes?.find((route) => route.id === selectedRouteId) || null;
  const ltaOk = health.data?.integrationsLive?.ltaConfigured;
  const googleOk = health.data?.integrationsLive?.googleRoutesLive;
  const oneMapOk = health.data?.integrationsLive?.oneMapTokenUsable;
  const alertMessages = alerts.data?.messages || [];
  const showAlerts = Boolean(alerts.data) && !alertsDismissed
    && (alerts.data?.status === 2 || alertMessages.length > 0);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <img src={new URL('./assets/logo.jpg', import.meta.url).href} alt="TranZip" className="app__logo-img" />
          <div>
            <h1 className="app__title">TranZip</h1>
            <p className="app__subtitle">Singapore Journey Planner with Live Load</p>
          </div>
        </div>
        <div className="app__status">
          <StatusPill ok={googleOk} label="Google Routes" offlineLabel="Google key missing" />
          <StatusPill ok={ltaOk} label="LTA DataMall" offlineLabel="LTA key missing" />
          <StatusPill ok={oneMapOk} label="OneMap" offlineLabel="OneMap token missing" />
        </div>
      </header>

      {showAlerts && (
        <div className="banner banner--warning app__alerts" role="alert">
          <span className="banner__icon" aria-hidden="true">🚇</span>
          <div className="banner__body">
            <strong>
              {pluralise(alertMessages.length, 'MRT service alert', 'MRT service alerts')}
              {' — '}{alerts.data.status === 2 ? 'disruption reported' : 'advisories'}
            </strong>
            <ul>
              {alertMessages.slice(0, 3).map((message, index) => (
                <li key={index}>{message.content}</li>
              ))}
            </ul>
          </div>
          <button type="button" className="banner__dismiss" onClick={() => setAlertsDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="app__main">
        <section className="app__panel">
          <PlannerForm
            origin={origin}
            destination={destination}
            onOriginChange={setOrigin}
            onDestinationChange={setDestination}
            onSwap={handleSwap}
            departureMode={departureMode}
            onDepartureModeChange={handleDepartureModeChange}
            departAt={departAt}
            onDepartAtChange={setDepartAt}
            tolerance={tolerance}
            onToleranceChange={setTolerance}
            modes={modes}
            onToggleMode={handleToggleMode}
            onPlan={() => planJourney()}
            planning={planning}
            disabled={false}
          />

          {planError && (
            <div className={classNames('banner', planError.isQuotaProblem ? 'banner--warning' : 'banner--error')}>
              <span className="banner__icon" aria-hidden="true">{planError.isQuotaProblem ? '⏳' : '⚠️'}</span>
              <div className="banner__body">
                <strong>Could not plan this journey</strong>
                <p>{planError.message}</p>
                {planError.isQuotaProblem && (
                  <p>The search or load quota is momentarily exhausted - wait a few seconds and try again.</p>
                )}
                {planError.isConfigProblem && (
                  <p>Ask the server operator to set LTA_ACCOUNT_KEY / ONEMAP_TOKEN in the .env file.</p>
                )}
              </div>
            </div>
          )}

          {plan && plan.warnings?.length > 0 && (
            <div className="banners">
              {plan.warnings.map((warning, index) => (
                <div
                  key={index}
                  className={classNames('banner', warning.mode === 'info' ? 'banner--info' : 'banner--warning')}
                >
                  <span className="banner__icon" aria-hidden="true">{warning.mode === 'info' ? 'ℹ️' : '⚠️'}</span>
                  <div className="banner__body"><p>{warning.message}</p></div>
                </div>
              ))}
            </div>
          )}

          {plan && (
            <div className="results">
              <div className="results-head">
                <div className="results-head__text">
                  <h2 className="results-head__title">
                    {pluralise(plan.routeCount, 'route')} · departs {formatClock(plan.departureTime)}
                  </h2>
                  <p className="results-head__sub">
                    Recommended: lowest passenger load within {plan.tolerancePercent}% of the fastest.
                    {plan.generatedAt && ` Updated ${relativeTime(plan.generatedAt)}.`}
                  </p>
                </div>
                <LoadScale compact />
              </div>

              <div className="routes">
                {plan.routes.map((route) => (
                  <RouteCard
                    key={route.id}
                    route={route}
                    expanded={expandedRouteId === route.id}
                    selected={selectedRouteId === route.id}
                    activeLegId={activeLegId}
                    onToggle={(toggled) => setExpandedRouteId((current) => (current === toggled.id ? null : toggled.id))}
                    onSelect={(selected) => {
                      setSelectedRouteId(selected.id);
                      setActiveLegId(null);
                    }}
                    onHoverLeg={setActiveLegId}
                  />
                ))}
              </div>
            </div>
          )}

          {!plan && planning && (
            <div className="routes">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skeleton-card" aria-hidden="true">
                  <span className="skeleton skeleton--title" />
                  <span className="skeleton skeleton--line" />
                  <span className="skeleton skeleton--line skeleton--short" />
                </div>
              ))}
            </div>
          )}

          {!plan && !planning && (
            <div className="empty">
              <div className="empty__icon" aria-hidden="true">🛰️</div>
              <h2>Plan a load-aware journey</h2>
              <ol className="empty__steps">
                <li><strong>Pick two places.</strong> Search any address, postal code or MRT station, use your location, or click the map to drop pins.</li>
                <li><strong>Choose your trade-off.</strong> Strict accepts routes within 5% of the fastest; Comfort accepts slower, emptier rides.</li>
                <li><strong>Plan.</strong> TranZip checks live bus and MRT passenger load and recommends the least crowded route within your time tolerance.</li>
              </ol>
              <button type="button" className="empty__try" onClick={runExample}>
                Try an example: Bishan → Marina Bay
              </button>
            </div>
          )}
        </section>

        <section className="app__map-pane">
          <MapView
            origin={origin}
            destination={destination}
            route={selectedRoute}
            activeLegId={activeLegId}
            onLegHover={setActiveLegId}
            onPickPoint={handlePickPoint}
            pickTarget={pickTarget}
          />
        </section>
      </main>

      <footer className="app__footer">
        <span>Data: LTA DataMall (bus &amp; MRT load) · OneMap (search, routing, basemap) · © Singapore Land Authority</span>
      </footer>
    </div>
  );
}

