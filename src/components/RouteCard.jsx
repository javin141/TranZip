import { classNames, formatFare, formatMinutes, pluralise } from '../lib/format.js';
import { lineSwatchColour, lineTextColour } from '../lib/constants.js';
import { LoadBadge } from './LoadBadge.jsx';
import { LegRow } from './LegTimeline.jsx';

/** Small chip describing one leg of the route (used in the collapsed card). */
function LegChip({ leg }) {
  const label = leg.type === 'bus'
    ? `Bus ${leg.serviceNo || leg.routeLabel}`
    : leg.type === 'mrt'
      ? leg.line || 'MRT'
      : leg.type === 'walk'
        ? 'Walk'
        : leg.routeLabel || 'Ride';
  const style = leg.type === 'mrt'
    ? { '--tone': lineTextColour(leg.line), '--tone-swatch': lineSwatchColour(leg.line) }
    : undefined;
  return (
    <span className={classNames('leg-chip', `leg-chip--${leg.type}`)} style={style} title={`${leg.from?.name} → ${leg.to?.name}`}>
      {label}
      {leg.type !== 'walk' && leg.load?.band && (
        <i className={classNames('leg-chip__dot', `leg-chip__dot--${leg.load.band.tone}`)} aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * One route result. The recommended route is rendered first by the API and gets
 * the "Recommended" ribbon plus the algorithm's reasoning.
 */
export function RouteCard({
  route,
  expanded,
  onToggle,
  onSelect,
  selected,
  activeLegId,
  onHoverLeg,
}) {
  const isRecommended = Boolean(route.recommended);
  const rideLegs = route.legs.filter((leg) => leg.type === 'bus' || leg.type === 'mrt');
  const fare = formatFare(route.fare);

  return (
    <article
      className={classNames(
        'route-card',
        isRecommended && 'route-card--recommended',
        selected && 'route-card--selected',
        expanded && 'is-expanded',
      )}
    >
      {isRecommended && (
        <p className="route-card__ribbon">
          <span className="route-card__ribbon-badge">Recommended</span>
          <span className="route-card__ribbon-text">{route.recommendationReason}</span>
        </p>
      )}

      {route.disrupted && (
        <p className="route-card__ribbon route-card__ribbon--warning">
          <span className="route-card__ribbon-badge route-card__ribbon-badge--warning">Service alert</span>
          <span className="route-card__ribbon-text">This route passes through a live LTA service alert.</span>
        </p>
      )}
      {!route.disrupted && route.rerouted && (
        <p className="route-card__ribbon route-card__ribbon--info">
          <span className="route-card__ribbon-badge route-card__ribbon-badge--info">Rerouted</span>
          <span className="route-card__ribbon-text">Replanned to avoid a live service alert.</span>
        </p>
      )}

      <header className="route-card__header">
        <button
          type="button"
          className="route-card__summary"
          onClick={() => onToggle(route)}
          aria-expanded={expanded}
        >
          <span className="route-card__duration">{formatMinutes(route.durationMinutes)}</span>
          <span className="route-card__started">
            {route.legs[0]?.departure ? `departs ${new Date(route.legs[0].departure).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false })}` : route.type}
          </span>
        </button>

        <div className="route-card__stats">
          <span className="route-card__stat">
            <em>Type</em>
            <strong>{route.type}</strong>
          </span>
          <span className="route-card__stat">
            <em>Changes</em>
            <strong>{route.transfers}</strong>
          </span>
          <span className="route-card__stat">
            <em>Walk</em>
            <strong>{formatMinutes(route.walkMinutes)}</strong>
          </span>
          {fare && (
            <span className="route-card__stat">
              <em>Fare</em>
              <strong>{fare}</strong>
            </span>
          )}
        </div>

        <LoadBadge band={route.load?.band} suffix={route.load?.legsWithData ? `${route.load.legsWithData}/${rideLegs.length}` : null} />
      </header>

      <div className="route-card__chips">
        {route.legs.map((leg) => (
          <LegChip key={leg.id} leg={leg} />
        ))}
      </div>

      <p className="route-card__load-note">
        {route.load?.summary}
        {route.load?.worstLeg && ` Busiest: ${route.load.worstLeg.label} (${route.load.worstLeg.band.label.toLowerCase()}).`}
        {route.load?.legsWithoutData > 0 && ` ${pluralise(route.load.legsWithoutData, 'leg')} without live data.`}
      </p>
      {route.weatherNote && (
        <p className="route-card__load-note route-card__load-note--weather">🌦️ {route.weatherNote}</p>
      )}
      {route.recommendationReason && !isRecommended && (
        <p className="route-card__load-note route-card__load-note--muted">{route.recommendationReason}</p>
      )}

      <footer className="route-card__footer">
        <button
          type="button"
          className={classNames('route-card__toggle', expanded && 'is-open')}
          onClick={() => onToggle(route)}
        >
          {expanded ? 'Hide details' : `Show ${rideLegs.length + (route.legs.length - rideLegs.length)} steps`}
        </button>
        <button
          type="button"
          className={classNames('route-card__map-button', selected && 'is-active')}
          onClick={() => onSelect(route)}
          disabled={selected}
        >
          {selected ? 'Shown on map' : 'Show on map'}
        </button>
      </footer>

      {expanded && (
        <ol className="leg-timeline">
          {route.legs.map((leg) => (
            <LegRow
              key={leg.id}
              leg={leg}
              expanded={activeLegId === leg.id}
              onHover={onHoverLeg ? () => onHoverLeg(leg.id) : undefined}
            />
          ))}
        </ol>
      )}
    </article>
  );
}