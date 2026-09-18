/** Presentation helpers shared by the React components. */

export function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(minutes || 0));
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatClock(isoString) {
  if (!isoString) return '--:--';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatFare(fare) {
  if (typeof fare !== 'number') return null;
  return `$${fare.toFixed(2)}`;
}

export function formatDistance(meters) {
  const value = Math.max(0, Math.round(meters || 0));
  if (value < 1000) return `${value} m`;
  return `${(value / 1000).toFixed(1)} km`;
}

export function formatArrivalMinutes(minutes) {
  if (minutes === null || minutes === undefined) return '--';
  if (minutes <= 0) return 'Now';
  return `${minutes} min`;
}

/** `1.350845, 103.848460` */
export function formatCoordinates(point) {
  if (!point) return '';
  return `${Number(point.latitude).toFixed(5)}, ${Number(point.longitude).toFixed(5)}`;
}

export function relativeTime(isoString) {
  if (!isoString) return '';
  const target = new Date(isoString).getTime();
  if (Number.isNaN(target)) return '';
  const diffSeconds = Math.round((Date.now() - target) / 1000);
  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds} s ago`;
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

/** Human label for a leg: `Bus 57`, `NSL`, `Walk`. */
export function legLabel(leg) {
  if (!leg) return '';
  if (leg.type === 'bus') return `Bus ${leg.serviceNo || leg.routeLabel}`;
  if (leg.type === 'mrt') return leg.lineName || leg.line || 'MRT';
  if (leg.type === 'walk') return 'Walk';
  return leg.routeLabel || leg.mode || 'Ride';
}