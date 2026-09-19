import { LOAD_TONES, toneForBand } from '../lib/constants.js';
import { classNames, formatClock } from '../lib/format.js';
import { useFreshness } from '../lib/freshness.js';

/**
 * Passenger-load chip: "Seats available" / "Standing available" /
 * "Limited standing" for buses, band label for MRT legs and whole journeys.
 *
 * When the data behind it is stale (offline, or old) it is dimmed, given a
 * dashed outline (so it isn't only colour that changes) and labelled with its
 * age, instead of passing as live.
 */
export function LoadBadge({ band, size = 'md', showDot = true, suffix = null, title }) {
  const tone = toneForBand(band);
  const { stale, ageLabel } = useFreshness();
  const hasReading = Boolean(band) && band.key !== 'unknown';
  const showAge = stale && hasReading;
  return (
    <span
      className={classNames(
        'load-badge',
        `load-badge--${size}`,
        `load-badge--${band?.tone || 'unknown'}`,
        showAge && 'is-stale',
      )}
      style={{ '--tone': tone.colour, '--tone-soft': tone.soft }}
      title={showAge ? `Not live - ${ageLabel}. ${band?.detail || ''}`.trim() : (title || band?.detail)}
    >
      {showDot && <span className="load-badge__dot" aria-hidden="true" />}
      <span className="load-badge__label">{band?.label || 'No live data'}</span>
      {suffix && <span className="load-badge__suffix">{suffix}</span>}
      {showAge && <span className="load-badge__age">{ageLabel}</span>}
    </span>
  );
}

/** Compact horizontal load meter, used on station rows. */
export function LoadMeter({ score, band, width = 64 }) {
  const tone = toneForBand(band);
  const filled = typeof score === 'number' ? Math.round(Math.min(1, Math.max(0, score)) * width) : 0;
  return (
    <span className="load-meter" style={{ '--tone': tone.colour, width }}>
      <span className="load-meter__fill" style={{ width: filled }} />
    </span>
  );
}

/** Legend explaining the three LTA load bands. */
export function LoadScale({ compact = false }) {
  const bands = [
    { tone: 'good', label: 'Seats available', hint: 'SEA · plenty of room' },
    { tone: 'moderate', label: 'Standing available', hint: 'SDA · aisle space left' },
    { tone: 'busy', label: 'Limited standing', hint: 'LSD · close to capacity' },
  ];
  return (
    <div className={classNames('load-scale', compact && 'load-scale--compact')}>
      {bands.map((band) => (
        <span
          key={band.tone}
          className={`load-scale__item load-scale__item--${band.tone}`}
          style={{ '--tone': LOAD_TONES[band.tone].colour }}
        >
          <span className="load-scale__swatch" aria-hidden="true" />
          <span>
            <strong>{band.label}</strong>
            {!compact && <em>{band.hint}</em>}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Small countdown pill for bus arrivals: how soon the service reaches the stop
 * and the load expected on that specific vehicle.
 */
export function ArrivalPill({ arrival }) {
  const { stale, ageLabel } = useFreshness();
  if (!arrival) return null;
  const tone = toneForBand(arrival.band);
  // "5 min away" stops being true the moment the data goes stale, but the
  // absolute time the bus was due still is, so show that instead.
  const stamp = stale && arrival.estimatedArrival ? formatClock(arrival.estimatedArrival) : null;
  return (
    <span
      className={classNames('arrival-pill', !arrival.monitored && 'arrival-pill--unmonitored', stale && 'is-stale')}
      style={{ '--tone': tone.colour, '--tone-soft': tone.soft }}
      title={stale
        ? `Not live - ${ageLabel}. This bus was due at ${stamp || 'an unknown time'}.`
        : (arrival.monitored ? 'Live vehicle position reported by LTA' : 'Scheduled only - LTA is not tracking this vehicle')}
    >
      <strong>{stamp || (arrival.minutesUntil === 0 ? 'Arr' : `${arrival.minutesUntil}′`)}</strong>
      <span className="arrival-pill__band">{arrival.band?.short || '—'}</span>
    </span>
  );
}