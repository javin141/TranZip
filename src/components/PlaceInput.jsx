import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { usePlaceSearch } from '../hooks/useJourney.js';
import { classNames, formatCoordinates } from '../lib/format.js';

/**
 * Autocomplete input backed by the OneMap search index. Accepts a searched
 * place, a raw coordinate pair, or the browser's current location.
 */
export function PlaceInput({
  label,
  icon,
  value,
  onChange,
  placeholder,
  accent = 'origin',
  autoFocus = false,
}) {
  const [text, setText] = useState(value?.name || '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listId = useId();

  const { results, loading, error } = usePlaceSearch(text);

  // Keep the visible text in sync when the value is set from outside
  // (map clicks, "use my location", swapped inputs).
  useEffect(() => {
    if (value?.name && value.name !== text) setText(value.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.name, value?.latitude, value?.longitude]);

  useEffect(() => {
    function handleDocumentClick(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, []);

  // Keyboard avoidance: the soft keyboard shrinks the visual viewport on
  // mobile, which can leave a focused input hidden behind it (especially
  // inside the bottom sheet's own scroll container). Re-center the input
  // whenever that happens, not just once on focus, since the keyboard
  // animates in over ~250ms and visualViewport tells us when it actually
  // finished rather than requiring a guessed timeout.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const handleViewportResize = () => {
      if (document.activeElement === inputRef.current) scrollInputIntoView();
    };
    viewport.addEventListener('resize', handleViewportResize);
    return () => viewport.removeEventListener('resize', handleViewportResize);
  }, []);

  function scrollInputIntoView() {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    inputRef.current?.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  const commit = (point) => {
    onChange(point);
    setText(point.name || formatCoordinates(point));
    setOpen(false);
    setHighlight(-1);
  };

  const chooseResult = (result) => commit({
    latitude: result.latitude,
    longitude: result.longitude,
    name: result.name,
    address: result.address,
  });

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlight((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setHighlight((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && highlight >= 0 && results[highlight]) {
        chooseResult(results[highlight]);
        return;
      }
      const parsed = parseCoordinates(text);
      if (parsed) commit({ ...parsed, name: formatCoordinates(parsed) });
      else if (results[0]) chooseResult(results[0]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        let name = 'Current location';
        let address = '';
        try {
          const resolved = await api.reverseGeocode(latitude, longitude);
          name = resolved?.name || name;
          address = resolved?.address || '';
        } catch {
          // Reverse geocoding consumes OneMap quota; coordinates alone still work.
        }
        setLocating(false);
        commit({ latitude, longitude, name, address });
      },
      (geoError) => {
        setLocating(false);
        setLocationError(geoError.message || 'Unable to read your location.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const showPanel = open && (results.length > 0 || loading || Boolean(error) || text.trim().length >= 2);

  return (
    <div className={classNames('place-input', `place-input--${accent}`)} ref={containerRef}>
      <div className="place-input__field">
        <span className="place-input__icon" aria-hidden="true">{icon}</span>
        <div className="place-input__body">
          <label className="place-input__label" htmlFor={`${listId}-input`}>{label}</label>
          <input
            id={`${listId}-input`}
            ref={inputRef}
            className="place-input__control"
            value={text}
            placeholder={placeholder}
            autoComplete="off"
            autoFocus={autoFocus}
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setHighlight(-1);
            }}
            onFocus={() => {
              setOpen(true);
              // Immediate attempt (helps when there's no keyboard to wait
              // for, e.g. a hardware keyboard or desktop); the
              // visualViewport listener above handles the mobile keyboard's
              // own animation timing.
              scrollInputIntoView();
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button
          type="button"
          className="place-input__locate"
          onClick={handleLocate}
          disabled={locating}
          title="Use my current location"
        >
          {locating ? '…' : '◎'}
        </button>
      </div>

      {value && (
        <p className="place-input__meta">
          <span>{value.name || 'Dropped pin'}</span>
          {value.address && <span className="place-input__address">{value.address}</span>}
          <span className="place-input__coords">{formatCoordinates(value)}</span>
        </p>
      )}
      {locationError && <p className="place-input__error">{locationError}</p>}

      {showPanel && (
        <ul className="place-input__results" id={listId} role="listbox">
          {loading && <li className="place-input__status">Searching OneMap…</li>}
          {!loading && error && (
            <li className="place-input__status place-input__status--error">{error.message}</li>
          )}
          {!loading && !error && results.length === 0 && text.trim().length >= 2 && (
            <li className="place-input__status">
              No matches. Try a postal code, MRT station or building name.
            </li>
          )}
          {results.map((result, index) => (
            <li key={`${result.name}-${result.latitude}-${result.longitude}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={classNames('place-input__option', index === highlight && 'is-active')}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => chooseResult(result)}
              >
                <strong>{result.name}</strong>
                <span>{result.address || formatCoordinates(result)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Accepts `1.3508, 103.8484` typed straight into the box. */
function parseCoordinates(raw) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw || '');
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}