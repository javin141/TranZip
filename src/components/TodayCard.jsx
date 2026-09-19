import { useState } from 'react';
import { classNames } from '../lib/format.js';
import { DEFAULT_DEPART_TIME, FLEX_OPTIONS } from '../lib/usualTrip.js';

const KIND_ICON = {
  disruption: '🚇',
  crowded: '🕒',
  fine: '✅',
  busy: '🚌',
  unknown: 'ℹ️',
  unavailable: '⚠️',
  passed: '⏱️',
  loading: '⏳',
};

/** Renders "[SIMULATED] ..." with the same visible tag the rest of the app uses. */
function Headline({ text }) {
  const match = /^\[SIMULATED\]\s*(.*)$/.exec(text || '');
  if (!match) return text;
  return (
    <>
      <span className="simulated-tag">[SIMULATED]</span>
      {' '}
      {match[1]}
    </>
  );
}

/**
 * The "Today" card: one line at the top of the app about the user's saved
 * usual trip. It only turns prominent (a highlighted card with the reason
 * and a "Show route" button up front) when the advice differs from simply
 * taking the usual trip; otherwise it stays a quiet single line.
 */
export function TodayCard({
  trip,
  advice: resource,
  plannerOrigin,
  plannerDestination,
  onSave,
  onRemove,
  onShowRoute,
  storageBlocked,
  notify,
  offline = false,
}) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(trip?.departTime || DEFAULT_DEPART_TIME);
  const [flex, setFlex] = useState(trip?.flexibilityMinutes ?? 30);

  // Advice is live data: with no signal, the last line we fetched must not linger as if it were current.
  const advice = offline ? null : (resource.data?.advice || null);
  const prominent = Boolean(advice?.prominent);
  const kind = offline ? 'unavailable' : (advice?.kind || (resource.error ? 'unavailable' : 'loading'));
  const canShowRoute = Boolean(advice?.signature || advice?.routeLabel) && advice?.kind !== 'unavailable' && advice?.kind !== 'passed';

  // Places to save: the planner's From/To when both are set, otherwise the ones already saved.
  const formOrigin = plannerOrigin && plannerDestination ? plannerOrigin : trip?.origin;
  const formDestination = plannerOrigin && plannerDestination ? plannerDestination : trip?.destination;
  const canSave = Boolean(formOrigin && formDestination && time);

  const openPanel = () => {
    setTime(trip?.departTime || DEFAULT_DEPART_TIME);
    setFlex(trip?.flexibilityMinutes ?? 30);
    setOpen(true);
  };

  const submit = (event) => {
    event.preventDefault();
    if (!canSave) return;
    onSave({ origin: formOrigin, destination: formDestination, departTime: time, flexibilityMinutes: Number(flex) });
    setOpen(false);
  };

  let headline;
  if (!trip) headline = null;
  else if (offline) headline = "No signal: can't check your usual trip right now.";
  else if (advice) headline = advice.headline;
  else if (resource.error) headline = "Couldn't check your usual trip right now.";
  else headline = `Checking your usual ${trip.departTime} trip…`;

  return (
    <section className="today" aria-label="Today: your usual trip">
      {!trip && !open && (
        <div className="today__bar today__bar--empty">
          <span className="today__icon" aria-hidden="true">📍</span>
          <div className="today__text">
            <p className="today__headline">Save your usual trip to get a heads-up before you leave.</p>
          </div>
          <div className="today__actions">
            <button type="button" className="today__button today__button--primary" onClick={openPanel}>
              Set up
            </button>
          </div>
        </div>
      )}

      {trip && (
        <div className={classNames('today__bar', prominent && 'today__bar--prominent', `today__bar--${kind}`)}>
          <span className="today__icon" aria-hidden="true">{KIND_ICON[kind] || KIND_ICON.fine}</span>
          <div className="today__text">
            <span className="today__tag">{prominent ? 'Heads-up' : 'Today'}</span>
            <p className="today__headline" role="status" aria-live="polite">
              <Headline text={headline} />
            </p>
            {advice && prominent && <p className="today__reason">{advice.reason}</p>}
            {advice && !prominent && (
              <details className="today__why">
                <summary>Why?</summary>
                <p className="today__reason">{advice.reason}</p>
              </details>
            )}
            {resource.error && !offline && (
              <button type="button" className="today__link" onClick={resource.reload}>Try again</button>
            )}
          </div>
          <div className="today__actions">
            {canShowRoute && (
              <button type="button" className="today__button today__button--primary" onClick={() => onShowRoute(advice, trip)}>
                Show route
              </button>
            )}
            <button
              type="button"
              className="today__button"
              onClick={open ? () => setOpen(false) : openPanel}
              aria-expanded={open}
            >
              {open ? 'Close' : 'Edit'}
            </button>
          </div>
        </div>
      )}

      {open && (
        <form className="today__panel" onSubmit={submit}>
          <h2 className="today__panel-title">My usual trip</h2>
          <p className="today__trip">
            <strong>{formOrigin?.name || 'From: not set'}</strong>
            <span aria-hidden="true"> → </span>
            <strong>{formDestination?.name || 'To: not set'}</strong>
          </p>
          <p className="control-group__hint">
            {plannerOrigin && plannerDestination
              ? 'Uses the From and To currently in the planner.'
              : trip
                ? "Keeps your saved From and To. To change them, set new ones in the planner first, then save."
                : 'Choose From and To in the planner first, then save them here.'}
          </p>

          <label className="today__field">
            <span className="control-group__label">Usual departure time</span>
            <input
              type="time"
              className="control-group__datetime"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              required
            />
          </label>

          <label className="today__field">
            <span className="control-group__label">Flexibility</span>
            <select className="control-group__datetime" value={flex} onChange={(event) => setFlex(event.target.value)}>
              {FLEX_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p className="control-group__hint">
            TranZip compares departures every 15 minutes across this window (at most 5 checks) and tells you if a
            different time would be quieter.
          </p>

          {notify.supported && (
            <div className="today__field">
              <label className="demo-switch">
                <input type="checkbox" checked={notify.on} onChange={notify.onToggle} />
                <span className="demo-switch__track" aria-hidden="true">
                  <span className="demo-switch__thumb" />
                </span>
                <span className="demo-switch__label">Notify me on this tab when the advice changes</span>
              </label>
              <p className="control-group__hint">
                Only works while this page stays open in a browser tab - TranZip cannot send background
                notifications, so if the tab or browser is closed you won't hear from it.
                {notify.blocked && ' Notifications are blocked for this site in your browser settings.'}
              </p>
            </div>
          )}

          <p className="today__privacy">
            <strong>Stored only in this browser</strong> (localStorage) - TranZip's server never saves it. The trip's
            coordinates are sent to the server only to check today's conditions, then forgotten.
            {storageBlocked && ' Your browser is blocking storage, so this trip will be lost when you close the page.'}
          </p>

          <div className="today__panel-actions">
            <button type="submit" className="today__button today__button--primary" disabled={!canSave}>
              Save my usual trip
            </button>
            {trip && (
              <button
                type="button"
                className="today__button"
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
              >
                Remove
              </button>
            )}
            <button type="button" className="today__button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
