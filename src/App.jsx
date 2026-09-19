import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client.js';
import { MapView } from './components/MapView.jsx';
import { PlannerForm } from './components/PlannerForm.jsx';
import { RouteCard } from './components/RouteCard.jsx';
import { BottomSheet } from './components/BottomSheet.jsx';
import { LoadScale } from './components/LoadBadge.jsx';
import { TodayCard } from './components/TodayCard.jsx';
import { useAsyncResource } from './hooks/useJourney.js';
import { useConnectivity } from './hooks/useConnectivity.js';
import { useTodayAdvice } from './hooks/useTodayAdvice.js';
import { DEFAULT_MODES, DEFAULT_TOLERANCE_PERCENT } from './lib/constants.js';
import { classNames, formatAlertTime, formatClock, pluralise, relativeTime } from './lib/format.js';
import { FreshnessContext, computeFreshness, describeSavedAt } from './lib/freshness.js';
import {
  buildSavedJourney,
  clearSavedJourney,
  loadSavedJourney,
  planFromSavedJourney,
  saveJourney,
} from './lib/savedJourney.js';
import {
  clearUsualTrip,
  loadNotifyPreference,
  loadUsualTrip,
  normaliseTrip,
  notificationsSupported,
  saveNotifyPreference,
  saveUsualTrip,
} from './lib/usualTrip.js';

const LARGE_TEXT_KEY = 'tranzip:largeText';

/** Reads the saved large-text preference; never throws (private browsing can block storage). */
function readLargeTextPreference() {
  try {
    return localStorage.getItem(LARGE_TEXT_KEY) === '1';
  } catch {
    return false;
  }
}

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
  // Open on a wide screen; on a phone, a single line until tapped.
  const [alertsOpen, setAlertsOpen] = useState(() => !window.matchMedia('(max-width: 960px)').matches);
  const [avoidWeather, setAvoidWeather] = useState(false);
  const [largeText, setLargeText] = useState(readLargeTextPreference);
  const [demoDisruptionOn, setDemoDisruptionOn] = useState(false);
  const [usualTrip, setUsualTrip] = useState(loadUsualTrip);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [notifyOn, setNotifyOn] = useState(
    () => notificationsSupported() && loadNotifyPreference() && Notification.permission === 'granted',
  );
  const [notifyBlocked, setNotifyBlocked] = useState(false);
  const lastNotifiedRef = useRef(null);
  const { offline, browserOnline } = useConnectivity();
  const [savedJourney, setSavedJourney] = useState(loadSavedJourney);
  // How much of the map's bottom the mobile sheet covers (0 on desktop).
  const [sheetInset, setSheetInset] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const wasOfflineRef = useRef(offline);
  const snapshotShownRef = useRef(false);

  // Ticks so "14 min old" labels and the stale threshold keep moving while nothing else re-renders.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.largeText = largeText ? 'true' : 'false';
    try {
      localStorage.setItem(LARGE_TEXT_KEY, largeText ? '1' : '0');
    } catch {
      // Private browsing or storage disabled - the toggle still works for this session.
    }
  }, [largeText]);

  const health = useAsyncResource((signal) => api.health(signal), []);
  const alerts = useAsyncResource((signal) => api.serviceAlerts(signal), []);
  const weather = useAsyncResource(
    (signal) => api.weatherNow(origin?.latitude ?? 1.3521, origin?.longitude ?? 103.8198, signal),
    [origin?.latitude, origin?.longitude],
  );

  // The toggle only exists when the server has DEMO_MODE=1 set - it's
  // absent from the payload entirely otherwise, not just falsy.
  const demoAvailable = Boolean(health.data?.demo?.available);
  useEffect(() => {
    if (health.data?.demo) setDemoDisruptionOn(Boolean(health.data.demo.disruptionActive));
  }, [health.data?.demo?.disruptionActive]);

  const toggleDemoDisruption = async () => {
    const next = !demoDisruptionOn;
    setDemoDisruptionOn(next); // optimistic; corrected below if the server disagrees
    try {
      const result = await api.setDemoDisruption(next);
      setDemoDisruptionOn(Boolean(result?.active));
    } catch {
      setDemoDisruptionOn(!next);
    }
    alerts.reload();
    todayAdvice.reload();
  };

  const todayAdvice = useTodayAdvice(usualTrip);

  const handleSaveTrip = (trip) => {
    const normalised = normaliseTrip(trip);
    if (!normalised) return;
    setStorageBlocked(!saveUsualTrip(normalised));
    setUsualTrip(normalised);
  };

  const handleRemoveTrip = () => {
    clearUsualTrip();
    setUsualTrip(null);
  };

  // Browser notifications: opt-in, and only ever fired by this page while it
  // is open. There is no service worker or push server behind this.
  const notifySupported = notificationsSupported();
  const toggleNotify = async () => {
    if (!notifySupported) return;
    if (notifyOn) {
      setNotifyOn(false);
      saveNotifyPreference(false);
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    const granted = permission === 'granted';
    setNotifyBlocked(!granted);
    setNotifyOn(granted);
    saveNotifyPreference(granted);
  };

  const todayAdviceData = todayAdvice.data?.advice;
  useEffect(() => {
    if (!notifyOn || !notifySupported || Notification.permission !== 'granted') return;
    if (!todayAdviceData?.prominent) return;
    const key = `${todayAdviceData.kind}|${todayAdviceData.departAt}|${todayAdviceData.headline}`;
    if (lastNotifiedRef.current === key) return;
    lastNotifiedRef.current = key;
    // If the page is on screen the card already says it; notify only when the tab is in the background.
    if (document.visibilityState === 'visible') return;
    try {
      new Notification('TranZip: your usual trip', { body: todayAdviceData.headline, tag: 'tranzip-today' });
    } catch {
      // Some mobile browsers refuse page-created notifications - the card still shows the advice.
    }
  }, [notifyOn, notifySupported, todayAdviceData]);

  const planJourney = useCallback(async (from = origin, to = destination, overrides = {}) => {
    if (!from || !to || planning) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const payload = {
        origin: from,
        destination: to,
        tolerance,
        modes,
        avoidWeather,
      };
      if (overrides.departAtIso !== undefined) {
        if (overrides.departAtIso) payload.departAt = overrides.departAtIso;
      } else if (departureMode === 'schedule' && departAt) {
        payload.departAt = new Date(departAt).toISOString();
      }
      const result = await api.planJourney(payload);
      // `receivedAt` is the device's clock at arrival: what every "how old is this?" label measures from.
      const receivedAt = Date.now();
      setPlan({ ...result, receivedAt });
      // "Show route" from the Today card wants the very route the advice named, if it's still on offer.
      const advised = overrides.signature
        ? result.routes?.find((route) => route.signature === overrides.signature)
        : null;
      const recommendedRoute = result.routes?.find((route) => route.recommended) || result.routes?.[0] || null;
      const recommended = advised || recommendedRoute;
      setSelectedRouteId(recommended?.id || null);
      setExpandedRouteId(recommended?.id || null);
      setActiveLegId(null);

      // Keep the recommended journey for use with no signal.
      if (recommendedRoute) {
        const saved = buildSavedJourney({
          plan: result, route: recommendedRoute, origin: from, destination: to, savedAtMs: receivedAt,
        });
        saveJourney(saved);
        setSavedJourney(saved);
      }
    } catch (error) {
      if (error.kind === 'network') {
        // No signal is not a planning failure: keep what is on screen (it gets
        // marked as out of date) and let the offline banner explain.
        setPlanError(null);
      } else {
        setPlan(null);
        setPlanError(error);
      }
    } finally {
      setPlanning(false);
    }
  }, [origin, destination, planning, tolerance, modes, departureMode, departAt, avoidWeather]);

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

  const handleShowAdviceRoute = (advice, trip) => {
    const at = advice?.departAt ? new Date(advice.departAt) : null;
    const isNow = !at || at.getTime() - Date.now() < 2 * 60 * 1000;
    setOrigin(trip.origin);
    setDestination(trip.destination);
    if (isNow) {
      setDepartureMode('now');
    } else {
      setDepartureMode('schedule');
      setDepartAt(localDateTimeInput(at));
    }
    planJourney(trip.origin, trip.destination, {
      departAtIso: isNow ? null : at.toISOString(),
      signature: advice?.signature || null,
    });
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

  // What the results area shows: the live plan, or - with no signal and no
  // plan this session (e.g. the app was opened underground) - the saved copy.
  const snapshotPlan = useMemo(() => (savedJourney ? planFromSavedJourney(savedJourney) : null), [savedJourney]);
  const displayPlan = plan || (offline ? snapshotPlan : null);
  const showingSnapshot = !plan && offline && Boolean(snapshotPlan);

  const freshness = useMemo(
    () => computeFreshness({ asOfMs: displayPlan?.receivedAt ?? null, offline, nowMs: nowTick }),
    [displayPlan?.receivedAt, offline, nowTick],
  );

  // Showing the saved copy: put its places on the map and select its route.
  useEffect(() => {
    if (!showingSnapshot) return;
    snapshotShownRef.current = true;
    setOrigin((current) => current || snapshotPlan.origin);
    setDestination((current) => current || snapshotPlan.destination);
    const routeId = snapshotPlan.routes[0]?.id || null;
    setSelectedRouteId(routeId);
    setExpandedRouteId(routeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingSnapshot]);

  // Signal is back: everything that was frozen is refreshed, and the journey
  // on screen (live or saved copy) is re-planned so it isn't left as old data.
  useEffect(() => {
    const wasOffline = wasOfflineRef.current;
    wasOfflineRef.current = offline;
    if (!wasOffline || offline) return;
    health.reload();
    alerts.reload();
    weather.reload();
    todayAdvice.reload();
    const hadSnapshot = snapshotShownRef.current;
    snapshotShownRef.current = false;
    if (origin && destination && (plan || hadSnapshot)) planJourney(origin, destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  // On a phone the results sit below the whole planner form inside the sheet,
  // so bring them into view when a plan (or the saved copy) appears.
  useEffect(() => {
    if (!displayPlan?.generatedAt) return undefined;
    if (!window.matchMedia('(max-width: 960px)').matches) return undefined;
    const frame = requestAnimationFrame(() => {
      // Scroll the sheet's own panel only: scrollIntoView would also shift the
      // page itself (even with overflow hidden), pushing the header off screen.
      const panel = document.querySelector('.app__panel');
      const results = document.querySelector('.results');
      if (panel && results) {
        panel.scrollTop += results.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [displayPlan?.generatedAt]);

  const handleClearSavedJourney = () => {
    clearSavedJourney();
    setSavedJourney(null);
  };

  const selectedRoute = displayPlan?.routes?.find((route) => route.id === selectedRouteId) || null;
  const ltaOk = health.data?.integrationsLive?.ltaConfigured;
  const googleOk = health.data?.integrationsLive?.googleRoutesLive;
  const oneMapOk = health.data?.integrationsLive?.oneMapTokenUsable;
  const alertMessages = [...(alerts.data?.messages || [])]
    .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  const alertsSimulated = Boolean(alerts.data?.simulated);
  // Alerts are live data; with no signal the last ones fetched would read as current, so they are hidden.
  const showAlerts = Boolean(alerts.data) && !alertsDismissed && !offline
    && (alerts.data?.status === 2 || alertMessages.length > 0);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <img src="/logo.jpg" alt="TranZip" width="34" height="34" className="app__logo-img" />
          <div>
            <h1 className="app__title">TranZip</h1>
            <p className="app__subtitle">Singapore Journey Planner with Live Load</p>
          </div>
        </div>
        <div className="app__status">
          <button
            type="button"
            className={classNames('text-size-toggle', largeText && 'is-active')}
            onClick={() => setLargeText((value) => !value)}
            aria-pressed={largeText}
            aria-label={largeText ? 'Switch to normal text size' : 'Switch to large text size'}
            title="Toggle large text"
          >
            A+
          </button>
          {offline ? (
            <span className="status-pill status-pill--warn">Offline</span>
          ) : (
            <span className="app__diagnostics">
              <StatusPill ok={googleOk} label="Google Routes" offlineLabel="Google key missing" />
              <StatusPill ok={ltaOk} label="LTA DataMall" offlineLabel="LTA key missing" />
              <StatusPill ok={oneMapOk} label="OneMap" offlineLabel="OneMap token missing" />
            </span>
          )}
        </div>
      </header>

      {offline && (
        <div className="banner banner--offline app__offline" role="status" aria-live="polite">
          <span className="banner__icon" aria-hidden="true">📡</span>
          <div className="banner__body">
            <strong>
              {savedJourney
                ? `Saved ${describeSavedAt(Date.parse(savedJourney.savedAt), nowTick)}. No signal, so this may be out of date.`
                : 'No signal, and no journey has been saved on this device yet.'}
            </strong>
            <p>
              {browserOnline
                ? "TranZip can't be reached right now."
                : 'Your device reports no connection.'}
              {' '}Retrying automatically.
              {savedJourney && ' Crowd levels and bus times below are from the saved time, not live.'}
            </p>
          </div>
        </div>
      )}

      <TodayCard
        trip={usualTrip}
        advice={todayAdvice}
        plannerOrigin={origin}
        plannerDestination={destination}
        onSave={handleSaveTrip}
        onRemove={handleRemoveTrip}
        onShowRoute={handleShowAdviceRoute}
        storageBlocked={storageBlocked}
        notify={{ supported: notifySupported, on: notifyOn, blocked: notifyBlocked, onToggle: toggleNotify }}
        offline={offline}
      />

      {showAlerts && (
        <div className="banner banner--warning app__alerts" role="alert">
          <div className="app__alerts-main">
            {/* One tappable line; the message list opens on demand so a long
                alert list can't eat a phone screen. */}
            <button
              type="button"
              className="app__alerts-summary"
              onClick={() => setAlertsOpen((open) => !open)}
              aria-expanded={alertsOpen}
            >
              <span className="banner__icon" aria-hidden="true">🚇</span>
              <span className="app__alerts-title">
                {alertsSimulated && <span className="simulated-tag">[SIMULATED]</span>}
                {alertsSimulated && ' '}
                {pluralise(alertMessages.length, 'MRT service alert', 'MRT service alerts')}
                {' — '}{alerts.data.status === 2 ? 'disruption reported' : 'advisories'}
              </span>
              <span className="app__alerts-chevron" aria-hidden="true">{alertsOpen ? '▴' : '▾'}</span>
            </button>
            {alertsOpen && (
              <div className="app__alerts-detail">
                <p className="app__alerts-more">Newest first</p>
                <ul>
                  {alertMessages.slice(0, 5).map((message, index) => (
                    <li key={index}>
                      <span className="app__alerts-time">{formatAlertTime(message.createdDate)}</span>
                      {' '}{message.content}
                    </li>
                  ))}
                </ul>
                {alertMessages.length > 5 && (
                  <p className="app__alerts-more">+ {alertMessages.length - 5} more</p>
                )}
              </div>
            )}
          </div>
          <button type="button" className="banner__dismiss" onClick={() => setAlertsDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="app__main">
        <BottomSheet openKey={displayPlan?.generatedAt} onInsetChange={setSheetInset}>
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
            weather={offline ? null : weather.data}
            avoidWeather={avoidWeather}
            onToggleAvoidWeather={() => setAvoidWeather((value) => !value)}
            demoAvailable={demoAvailable}
            demoDisruptionOn={demoDisruptionOn}
            onToggleDemoDisruption={toggleDemoDisruption}
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

          {displayPlan && displayPlan.warnings?.length > 0 && (
            <div className="banners">
              {displayPlan.warnings.map((warning, index) => (
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

          {displayPlan && (
            <FreshnessContext.Provider value={freshness}>
            <div className={classNames('results', freshness.stale && 'results--stale')}>
              <div className="results-head">
                <div className="results-head__text">
                  <h2 className="results-head__title">
                    {showingSnapshot ? 'Saved journey' : pluralise(displayPlan.routeCount, 'route')}
                    {' · '}departs {formatClock(displayPlan.departureTime)}
                  </h2>
                  <p className="results-head__sub">
                    {showingSnapshot
                      ? 'The route that was recommended when this was last planned.'
                      : `Recommended: lowest passenger load within ${displayPlan.tolerancePercent}% of the fastest.`}
                    {!freshness.stale && displayPlan.receivedAt
                      && ` Updated ${relativeTime(new Date(displayPlan.receivedAt).toISOString())}.`}
                  </p>
                </div>
                <LoadScale compact />
              </div>

              {freshness.stale && (
                <p className="results__stale" role="note">
                  <strong>Not live.</strong>
                  {` Crowd levels, bus arrivals and alerts are from ${freshness.asOfClock} (${freshness.ageLabel}) and may be out of date.`}
                  {!offline && (
                    <button type="button" className="results__stale-action" onClick={() => planJourney()} disabled={planning}>
                      Refresh
                    </button>
                  )}
                </p>
              )}

              <div className="routes">
                {displayPlan.routes.map((route) => (
                  <RouteCard
                    key={route.id}
                    route={route}
                    baselineMinutes={displayPlan.baselineRoute?.durationMinutes ?? null}
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

              {savedJourney && (
                <p className="results__saved">
                  A copy of your last journey is saved on this device so it still opens with no signal.
                  <button type="button" className="results__stale-action" onClick={handleClearSavedJourney}>
                    Clear saved copy
                  </button>
                </p>
              )}
            </div>
            </FreshnessContext.Provider>
          )}

          {!displayPlan && planning && (
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

          {!displayPlan && !planning && (
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
        </BottomSheet>

        <section className="app__map-pane">
          <MapView
            origin={origin}
            destination={destination}
            route={selectedRoute}
            baselineRoute={displayPlan?.baselineRoute || null}
            bottomInset={sheetInset}
            activeLegId={activeLegId}
            onLegHover={setActiveLegId}
            onPickPoint={handlePickPoint}
            pickTarget={pickTarget}
          />
        </section>
      </main>

      <footer className="app__footer">
        <span>Data: LTA DataMall (bus &amp; MRT load) · NEA/data.gov.sg (weather) · OneMap (search &amp; routing) · © Singapore Land Authority</span>
        <span>
          Data &amp; licences: LTA DataMall · NEA/data.gov.sg · OneMap ·{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
          {' '}(<a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noreferrer">ODbL</a>)
        </span>
      </footer>
    </div>
  );
}

