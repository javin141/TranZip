/**
 * "My usual trip": the one thing TranZip saves about a user, in this
 * browser's localStorage only. The server never stores it - the trip's
 * coordinates are sent to /api/journey/window just to plan, then forgotten.
 * Every read and write is wrapped because storage can be blocked (private
 * browsing, site data disabled); the feature then works for the session only.
 */

const TRIP_KEY = 'tranzip:usualTrip';
const NOTIFY_KEY = 'tranzip:notify';

/** How much later than usual the user is willing to leave. */
export const FLEX_OPTIONS = [
  { value: 0, label: 'Not flexible' },
  { value: 15, label: 'Up to 15 min later' },
  { value: 30, label: 'Up to 30 min later' },
  { value: 45, label: 'Up to 45 min later' },
  { value: 60, label: 'Up to 60 min later' },
];

export const DEFAULT_DEPART_TIME = '08:00';

const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Keeps only what planning needs; drops anything else that was ever attached to a place. */
function cleanPlace(place) {
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { name: String(place?.name || 'Saved place').slice(0, 120), latitude, longitude };
}

/** Validates and normalises a trip object; returns null if it isn't usable. */
export function normaliseTrip(raw) {
  const origin = cleanPlace(raw?.origin);
  const destination = cleanPlace(raw?.destination);
  const flexibilityMinutes = Number(raw?.flexibilityMinutes);
  if (!origin || !destination || !isTime(raw?.departTime)) return null;
  return {
    origin,
    destination,
    departTime: raw.departTime,
    flexibilityMinutes: FLEX_OPTIONS.some((option) => option.value === flexibilityMinutes) ? flexibilityMinutes : 0,
  };
}

export function loadUsualTrip() {
  try {
    const text = localStorage.getItem(TRIP_KEY);
    return text ? normaliseTrip(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** @returns {boolean} whether it was actually persisted */
export function saveUsualTrip(trip) {
  try {
    localStorage.setItem(TRIP_KEY, JSON.stringify(trip));
    return true;
  } catch {
    return false;
  }
}

export function clearUsualTrip() {
  try {
    localStorage.removeItem(TRIP_KEY);
  } catch {
    // Nothing stored, or storage blocked - either way there's nothing to clear.
  }
}

export function loadNotifyPreference() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveNotifyPreference(enabled) {
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? '1' : '0');
  } catch {
    // Session-only preference if storage is blocked.
  }
}

/** Today's date at the saved "HH:MM", in the device's local time. */
export function usualDepartureToday(departTime, now = new Date()) {
  const [hours, minutes] = String(departTime).split(':').map(Number);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;
