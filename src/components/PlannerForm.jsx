import { MODE_OPTIONS, TOLERANCE_OPTIONS } from '../lib/constants.js';
import { classNames } from '../lib/format.js';
import { PlaceInput } from './PlaceInput.jsx';

/** Origin/destination form plus the two knobs the recommendation rule needs. */
export function PlannerForm({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  onSwap,
  departureMode,
  onDepartureModeChange,
  departAt,
  onDepartAtChange,
  tolerance,
  onToleranceChange,
  modes,
  onToggleMode,
  weather,
  avoidWeather,
  onToggleAvoidWeather,
  demoAvailable,
  demoDisruptionOn,
  onToggleDemoDisruption,
  onPlan,
  planning,
  disabled,
}) {
  const canPlan = Boolean(origin && destination) && !planning;
  const selectedTolerance = TOLERANCE_OPTIONS.find((option) => option.value === tolerance) || TOLERANCE_OPTIONS[1];
  const weatherAdverse = weather && weather.condition !== 'clear';
  const weatherLabel = weather?.condition === 'rain'
    ? `🌧️ Raining now${typeof weather.rainfallMm === 'number' && weather.rainfallMm > 0 ? ` (${weather.rainfallMm.toFixed(1)}mm)` : ''} - prefer sheltered/bus routes?`
    : weather?.condition === 'hot'
      ? `🌡️ Hot now (${Math.round(weather.temperatureC)}°C) - prefer routes with less walking?`
      : '☀️ Weather is clear right now - avoid rain/heat anyway?';

  return (
    <form
      className="planner"
      onSubmit={(event) => {
        event.preventDefault();
        if (canPlan) onPlan();
      }}
    >
      <div className="planner__places">
        <PlaceInput
          label="From"
          icon="◉"
          accent="origin"
          value={origin}
          onChange={onOriginChange}
          placeholder="Postal code, MRT station or building"
          autoFocus
        />
        <button
          type="button"
          className="planner__swap"
          onClick={onSwap}
          title="Swap origin and destination"
          aria-label="Swap origin and destination"
        >
          ⇅
        </button>
        <PlaceInput
          label="To"
          icon="◎"
          accent="destination"
          value={destination}
          onChange={onDestinationChange}
          placeholder="Where are you heading?"
        />
      </div>

      <div className="planner__controls">
        <div className="control-group">
          <span className="control-group__label">Departure</span>
          <div className="segmented">
            {[
              { value: 'now', label: 'Now' },
              { value: 'schedule', label: 'Later' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={classNames('segmented__item', departureMode === option.value && 'is-active')}
                onClick={() => onDepartureModeChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {departureMode === 'schedule' && (
            <input
              type="datetime-local"
              className="control-group__datetime"
              value={departAt}
              onChange={(event) => onDepartAtChange(event.target.value)}
            />
          )}
        </div>

        <div className="control-group">
          <span className="control-group__label">Travel time allowance</span>
          <div className="segmented">
            {TOLERANCE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={classNames('segmented__item', tolerance === option.value && 'is-active')}
                onClick={() => onToleranceChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="control-group__hint">{selectedTolerance.hint}</p>
        </div>

        <div className="control-group control-group--modes">
          <span className="control-group__label">Route types</span>
          <div className="chips">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={classNames('chip', modes.includes(option.value) && 'is-active')}
                onClick={() => onToggleMode(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {weather && (
          <div className="control-group control-group--weather">
            <span className="control-group__label">Weather</span>
            <button
              type="button"
              className={classNames(
                'chip',
                'chip--weather',
                avoidWeather && 'is-active',
                weatherAdverse && 'chip--weather-adverse',
              )}
              onClick={onToggleAvoidWeather}
              title="When it's raining or hot, prefer routes that spend less time walking outdoors."
            >
              {weatherLabel}
            </button>
          </div>
        )}

        {demoAvailable && (
          <div className="control-group control-group--demo">
            <span className="control-group__label">Demo</span>
            <label className="demo-switch">
              <input
                type="checkbox"
                checked={Boolean(demoDisruptionOn)}
                onChange={onToggleDemoDisruption}
              />
              <span className="demo-switch__track" aria-hidden="true">
                <span className="demo-switch__thumb" />
              </span>
              <span className="demo-switch__label">Demo: simulate NEL disruption (Punggol area)</span>
            </label>
            {demoDisruptionOn && (
              <p className="control-group__hint">
                [SIMULATED] A fake North East Line disruption is live for every user of this server right now -
                turn it off when you're done.
              </p>
            )}
          </div>
        )}

        <button type="submit" className="planner__submit" disabled={!canPlan}>
          {planning ? 'Planning…' : 'Plan journey'}
        </button>
      </div>

      <p className="planner__hint">
        Recommendation rule: among routes within
        {' '}
        <strong>{tolerance}%</strong>
        {' '}
        of the fastest travel time, the one with the lowest passenger load wins.
        {avoidWeather && ' When it\'s raining or hot, routes with less time on foot are favoured too.'}
        {!disabled && ' Load comes from LTA DataMall; routing and the map come from OneMap.'}
      </p>
    </form>
  );
}