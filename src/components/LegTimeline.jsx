import {
  classNames,
  formatArrivalMinutes,
  formatClock,
  formatDistance,
  formatMinutes,
  legLabel,
} from '../lib/format.js';
import { LEG_COLOURS, lineSwatchColour, toneForBand } from '../lib/constants.js';
import { ArrivalPill, LoadBadge } from './LoadBadge.jsx';

const LEG_ICONS = {
  bus: '🚌',
  mrt: '🚇',
  walk: '🚶',
  other: '🚊',
};

function legColour(leg) {
  if (leg?.type === 'mrt') return lineSwatchColour(leg.line);
  return LEG_COLOURS[leg?.type] || LEG_COLOURS.other;
}

/** Indented list of intermediate stops for an expanded leg. */
function StopsList({ leg }) {
  const stops = leg.intermediateStops || [];
  if (stops.length === 0) return null;
  const tone = leg.type === 'walk' ? LEG_COLOURS.walk : toneForBand(leg.load?.band).colour;
  return (
    <div className="leg-detail__row">
      <span className="leg-detail__key">{`Stops (${stops.length})`}</span>
      <ul className="stops-list">
        {stops.map((stop, index) => (
          <li key={`${stop.code || stop.name}-${index}`} className="stops-list__item">
            <span className="stops-list__dot" style={{ '--tone': tone }} aria-hidden="true" />
            <span className="stops-list__name">{stop.name || stop.code || 'Unnamed stop'}</span>
            {stop.time && <span className="stops-list__time">{formatClock(stop.time)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WalkDetails({ leg }) {
  return (
    <div className="leg-detail">
      <div className="leg-detail__row">
        <span className="leg-detail__key">Distance</span>
        <span className="leg-detail__value">{formatDistance(leg.distanceMeters)} on foot</span>
      </div>
      <p className="leg-detail__note">Walking pace is estimated at about 75 metres per minute.</p>
    </div>
  );
}

function BusDetails({ leg }) {
  const load = leg.load || {};
  const boarding = load.boarding;
  const upcoming = load.upcoming || [];
  const service = load.service;
  return (
    <div className="leg-detail">
      {boarding && (
        <div className="leg-detail__row">
          <span className="leg-detail__key">Boarding</span>
          <span className="leg-detail__value">
            {boarding.monitored
              ? `Arriving in ${formatArrivalMinutes(boarding.minutesUntil)}`
              : 'Scheduled only - not tracked live'}
            {boarding.busTypeLabel && ` · ${boarding.busTypeLabel}`}
            {boarding.approximateCapacity ? ` (~${boarding.approximateCapacity} passengers)` : ''}
          </span>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="leg-detail__row">
          <span className="leg-detail__key">Next buses</span>
          <span className="arrival-list">
            {upcoming.map((arrival) => (
              <ArrivalPill key={`${arrival.estimatedArrival}-${arrival.minutesUntil}`} arrival={arrival} />
            ))}
          </span>
        </div>
      )}
      {service?.operator && (
        <div className="leg-detail__row">
          <span className="leg-detail__key">Service</span>
          <span className="leg-detail__value">
            {[service.operator, service.category, service.frequency ? `every ${service.frequency}` : null]
              .filter(Boolean)
              .join(' · ')}
            {service.towards?.name ? ` · towards ${service.towards.name}` : ''}
          </span>
        </div>
      )}
      <StopsList leg={leg} />
      {load.note && <p className="leg-detail__note">{load.note}</p>}
      {load.source && <p className="leg-detail__source">{load.source}</p>}
    </div>
  );
}

function RailDetails({ leg }) {
  const load = leg.load || {};
  const stations = load.stations || [];
  return (
    <div className="leg-detail">
      {leg.disrupted && (
        <p className="leg-detail__note leg-detail__note--warning">⚠️ {leg.disruptionNote || 'Affected by a live LTA service alert.'}</p>
      )}
      {stations.length > 0 && (
        <div className="leg-detail__row">
          <span className="leg-detail__key">Crowd by station</span>
          <ol className="station-strip">
            {stations.map((station) => (
              <li
                key={station.code || station.name}
                className={classNames(
                  'station-strip__item',
                  station.isInterchange && 'station-strip__item--interchange',
                )}
                title={`${station.name} · ${station.band?.label || 'no live data'}`
                  + (station.isInterchange ? ` · interchange with ${(station.interchangeWith || []).join(', ')}` : '')}
              >
                <span
                  className="station-strip__dot"
                  style={{ '--tone': toneForBand(station.band).colour }}
                  aria-hidden="true"
                />
                <span className="station-strip__name">{station.name}</span>
                <span className="station-strip__band">{station.band?.short}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {load.peakStation && (
        <div className="leg-detail__row">
          <span className="leg-detail__key">Busiest station</span>
          <span className="leg-detail__value">
            {load.peakStation.name}
            {load.peakStation.expectedTime ? ` (arriving ${formatClock(load.peakStation.expectedTime)})` : ''}
            {' — '}
            {load.peakStation.band?.label}
          </span>
        </div>
      )}
      <StopsList leg={leg} />
      {load.note && <p className="leg-detail__note">{load.note}</p>}
      {load.source && <p className="leg-detail__source">{load.source}</p>}
    </div>
  );
}

/**
 * One row of the expanded step timeline. Hovering or tapping a row flags the
 * leg as active, which expands its detail block and highlights it on the map.
 */
export function LegRow({ leg, expanded, onHover }) {
  const isRide = leg.type === 'bus' || leg.type === 'mrt';
  return (
    <li
      className={classNames('leg-row', `leg-row--${leg.type}`, expanded && 'is-expanded')}
      onClick={onHover}
    >
      <span className="leg-row__marker" style={{ '--leg-tone': legColour(leg) }} aria-hidden="true">
        {LEG_ICONS[leg.type] || LEG_ICONS.other}
      </span>
      <div className="leg-row__body">
        <header className="leg-row__head">
          <span className="leg-row__title">
            <strong>{legLabel(leg)}</strong>
            {isRide && leg.numStops > 0 && (
              <span className="leg-row__sub">{`${leg.numStops} stop${leg.numStops === 1 ? '' : 's'}`}</span>
            )}
            {leg.disrupted && <span className="leg-row__alert" title="Live service alert">⚠️</span>}
          </span>
          <span className="leg-row__times">
            <span>{formatClock(leg.departure)} – {formatClock(leg.arrival)}</span>
            <em>{formatMinutes(leg.durationMinutes)}</em>
          </span>
          {isRide
            ? <LoadBadge band={leg.load?.band} size="sm" />
            : <span className="leg-row__walkmeta">{formatDistance(leg.distanceMeters)}</span>}
        </header>
        <p className="leg-row__path">
          {leg.from?.name || 'Start'}
          <span aria-hidden="true"> → </span>
          {leg.to?.name || 'End'}
        </p>
        {expanded && (
          <div className="leg-detail">
            {leg.type === 'bus' && <BusDetails leg={leg} />}
            {leg.type === 'mrt' && <RailDetails leg={leg} />}
            {leg.type === 'walk' && <WalkDetails leg={leg} />}
            {leg.type === 'other' && <p className="leg-detail__note">{leg.routeLabel || 'Other transport'}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

