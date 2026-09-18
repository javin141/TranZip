import { toneForBand } from '../lib/constants.js';
import { classNames } from '../lib/format.js';

/**
 * Passenger-load chip: "Seats available" / "Standing available" /
 * "Limited standing" for buses, band label for MRT legs and whole journeys.
 */
export function LoadBadge({ band, size = 'md', showDot = true, suffix = null, title }) {
  const tone = toneForBand(band);
  return (
    <span
      className={classNames('load-badge', `load-badge--${size}`, `load-badge--${band?.tone || 'unknown'}`)}
      style={{ '--tone': tone.colour, '--tone-soft': tone.soft }}
      title={title || band?.detail}
    >
      {showDot && <span className="load-badge__dot" aria-hidden="true" />}
      <span className="load-badge__label">{band?.label || 'No live data'}</span>
      {suffix && <span className="load-badge__suffix">{suffix}</span>}
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
    { tone: 'seats', label: 'Seats available', hint: 'SEA · plenty of room' },
    { tone: 'standing', label: 'Standing available', hint: 'SDA · aisle space left' },
    { tone: 'limited', label: 'Limited standing', hint: 'LSD · close to capacity' },
  ];
  return (
    <div className={classNames('load-scale', compact && 'load-scale--compact')}>
      {bands.map((band) => (
        <span key={band.tone} className={`load-scale__item load-scale__item--${band.tone}`}>
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
  if (!arrival) return null;
  const tone = toneForBand(arrival.band);
  return (
    <span
      className={classNames('arrival-pill', !arrival.monitored && 'arrival-pill--unmonitored')}
      style={{ '--tone': tone.colour }}
      title={arrival.monitored ? 'Live vehicle position reported by LTA' : 'Scheduled only - LTA is not tracking this vehicle'}
    >
      <strong>{arrival.minutesUntil === 0 ? 'Arr' : `${arrival.minutesUntil}′`}</strong>
      <span className="arrival-pill__band">{arrival.band?.short || '—'}</span>
    </span>
  );
}