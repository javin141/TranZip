import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LEG_COLOURS, ONEMAP_ATTRIBUTION, TILE_ATTRIBUTION, TILE_URL, lineSwatchColour } from '../lib/constants.js';
import { classNames, legLabel } from '../lib/format.js';

const SINGAPORE_CENTER = [1.3521, 103.8198];
// OSM contributors credited first, then the tile provider, then OneMap
// (still used for search/routing even though it's no longer the map layer).
const MAP_ATTRIBUTION = `${TILE_ATTRIBUTION} | ${ONEMAP_ATTRIBUTION}`;

function pinIcon(kind) {
  const glyph = kind === 'origin' ? '◉' : '◎';
  return L.divIcon({
    className: 'map-pin-icon',
    html: `<span class="map-pin map-pin--${kind}">${glyph}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    tooltipAnchor: [0, -14],
  });
}

const warningIcon = L.divIcon({
  className: 'map-warning-icon',
  html: '<span class="map-warning" aria-hidden="true">⚠</span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

/** Extracts a usable [lat, lng][] polyline from a leg, falling back to a straight line between its endpoints. */
function legPoints(leg) {
  const points = (leg.geometry || [])
    .map(([lat, lng]) => [Number(lat), Number(lng)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  if (points.length < 2 && leg.from?.latitude != null && leg.to?.latitude != null) {
    return [[leg.from.latitude, leg.from.longitude], [leg.to.latitude, leg.to.longitude]];
  }
  return points;
}

/**
 * Marks a leg's stretch as affected by a live disruption: a tight red dash
 * pattern overlaid on the base line (distinct from a merely-dashed walk leg
 * or the baseline's own wide dashes), plus a warning glyph at the segment's
 * midpoint. Colour is never the only cue - the dash density and the icon
 * (with its "Affected" tooltip) carry the meaning too. Reuses the leg's own
 * `affectedNote` (same text as the step-by-step detail panel, already
 * carrying a "[SIMULATED]" prefix when applicable) rather than a separate
 * hardcoded string, so the map never disagrees with the rest of the UI.
 */
function markAffected(points, layer, note) {
  const tooltipText = `⚠ ${note || 'Affected - live service alert on this stretch'}`;
  L.polyline(points, {
    color: '#c5221f',
    weight: 5,
    opacity: 0.95,
    dashArray: '1 7',
    lineCap: 'round',
  })
    .bindTooltip(tooltipText, { sticky: true, className: 'map-tooltip' })
    .addTo(layer);
  const mid = points[Math.floor(points.length / 2)];
  L.marker(mid, { icon: warningIcon, zIndexOffset: 400 })
    .bindTooltip(tooltipText, { className: 'map-tooltip' })
    .addTo(layer);
}

/**
 * OpenStreetMap-derived basemap (see TILE_URL in lib/constants.js) with the
 * selected route drawn leg by leg. Bus legs are cyan, MRT legs their real
 * Singapore line colour, walks a dashed light blue; the active leg (clicked
 * in the timeline or on the map) is drawn thicker and its stops get dots.
 * When a live disruption is active, the "usual" (pre-disruption) route is
 * drawn underneath in grey dashes for comparison, and any leg - on either
 * route - that actually runs through the disruption gets a red hatched
 * overlay and a warning icon, never colour alone. Clicking the map reports
 * the point back to the app so it can fill the origin or destination.
 */
export function MapView({
  origin,
  destination,
  route,
  baselineRoute,
  activeLegId,
  onLegHover,
  onPickPoint,
  pickTarget,
  bottomInset = 0,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const routeLayerRef = useRef(null);
  const baselineLayerRef = useRef(null);
  const pinLayerRef = useRef(null);
  const pickRef = useRef(onPickPoint);
  const hoverRef = useRef(onLegHover);
  const fittedForRef = useRef(null);
  // What the map is currently framing (the route, or the pins), how much of
  // its bottom is covered by the mobile sheet, and whether the user has taken
  // over panning/zooming. Kept in refs so a container resize can re-frame
  // without re-running the drawing effects.
  const fitTargetRef = useRef(null);
  const bottomInsetRef = useRef(bottomInset);
  const userMovedRef = useRef(false);
  const fitCurrentRef = useRef(() => {});
  const [legendOpen, setLegendOpen] = useState(true);

  fitCurrentRef.current = () => {
    const map = mapRef.current;
    const target = fitTargetRef.current;
    if (!map || !target || !target.bounds.isValid()) return;
    const size = map.getSize();
    if (size.x < 50 || size.y < 50) return;
    // Leave the part of the map the bottom sheet covers out of the frame, but
    // never let it squeeze the route into a sliver.
    const covered = size.y > 200 ? Math.max(0, Math.min(bottomInsetRef.current, size.y - 130)) : 0;
    map.fitBounds(target.bounds, {
      paddingTopLeft: [34, 34],
      paddingBottomRight: [34, 34 + covered],
      maxZoom: target.maxZoom,
      animate: false,
    });
  };

  useEffect(() => {
    bottomInsetRef.current = bottomInset;
    if (!userMovedRef.current) fitCurrentRef.current();
  }, [bottomInset]);

  useEffect(() => {
    pickRef.current = onPickPoint;
  }, [onPickPoint]);

  useEffect(() => {
    hoverRef.current = onLegHover;
  }, [onLegHover]);

  // Create the map exactly once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, {
      center: SINGAPORE_CENTER,
      zoom: 12,
      zoomControl: true,
    });
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: MAP_ATTRIBUTION,
    }).addTo(map);
    // Baseline drawn first (underneath), then the actual route on top.
    baselineLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    pinLayerRef.current = L.layerGroup().addTo(map);
    map.on('click', (event) => {
      pickRef.current?.({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    });
    mapRef.current = map;
    const resize = setTimeout(() => map.invalidateSize(), 60);

    // The map's box changes after it is created (banners and the "Today" card
    // load in above it, the alerts list opens, the phone rotates). Leaflet
    // does not notice on its own and keeps drawing for the old size, which
    // crops the route; so tell it, and re-frame unless the user has moved the map.
    const container = containerRef.current;
    const markMoved = () => { userMovedRef.current = true; };
    map.on('dragstart', markMoved);
    const onWheel = () => markMoved();
    const onTouch = (event) => { if (event.touches.length > 1) markMoved(); };
    const onClick = (event) => { if (event.target.closest?.('.leaflet-control-zoom')) markMoved(); };
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchstart', onTouch, { passive: true });
    container.addEventListener('click', onClick);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        map.invalidateSize({ animate: false });
        if (!userMovedRef.current) fitCurrentRef.current();
      });
    observer?.observe(container);

    return () => {
      clearTimeout(resize);
      observer?.disconnect();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouch);
      container.removeEventListener('click', onClick);
      map.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      baselineLayerRef.current = null;
      pinLayerRef.current = null;
    };
  }, []);

  // Draw the selected route: one polyline per leg (solid, thick, mode-coloured -
  // this is the actual recommendation, drawn on top of any baseline below),
  // dots for the active leg's stops, and a red-hatched overlay + warning icon
  // on any leg a live disruption still runs through.
  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = [];

    for (const leg of route?.legs || []) {
      const points = legPoints(leg);
      if (points.length < 2) continue;

      const isActive = leg.id === activeLegId;
      const line = L.polyline(points, {
        color: leg.type === 'mrt' ? lineSwatchColour(leg.line) : (LEG_COLOURS[leg.type] || LEG_COLOURS.other),
        weight: isActive ? 9 : 7,
        opacity: activeLegId && !isActive ? 0.35 : 1,
        dashArray: leg.type === 'walk' ? '2 7' : undefined,
        lineCap: 'round',
        lineJoin: 'round',
      });
      line.bindTooltip(legLabel(leg), { sticky: true, className: 'map-tooltip' });
      line.on('click', () => hoverRef.current?.(leg.id));
      line.addTo(layer);
      for (const point of points) bounds.push(point);
      if (leg.affected) markAffected(points, layer, leg.affectedNote);

      if (isActive) {
        const stops = [leg.from, ...(leg.intermediateStops || []), leg.to]
          .filter((stop) => stop && stop.latitude != null && stop.longitude != null);
        for (const stop of stops) {
          L.circleMarker([stop.latitude, stop.longitude], {
            radius: 4.5,
            color: '#0b1020',
            weight: 1.5,
            fillColor: '#e2e8f0',
            fillOpacity: 0.95,
          })
            .bindTooltip(stop.name || stop.code || 'Stop', { className: 'map-tooltip' })
            .addTo(layer);
        }
      }
    }

    if (route?.id && bounds.length > 0 && route.id !== fittedForRef.current) {
      fittedForRef.current = route.id;
      const allBounds = [...bounds];
      for (const leg of baselineRoute?.legs || []) allBounds.push(...legPoints(leg));
      fitTargetRef.current = { bounds: L.latLngBounds(allBounds), maxZoom: 15 };
      userMovedRef.current = false;
      fitCurrentRef.current();
    }
  }, [route, activeLegId, baselineRoute]);

  // Draw the "usual" (pre-disruption) route underneath, when one was planned:
  // wide grey dashes for the normal stretch, tight red dashes + a warning
  // icon for the part a live disruption actually blocks - distinguishable
  // from the recommendation above by colour, dash pattern, weight and label,
  // not colour alone.
  useEffect(() => {
    const map = mapRef.current;
    const layer = baselineLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const leg of baselineRoute?.legs || []) {
      const points = legPoints(leg);
      if (points.length < 2) continue;

      L.polyline(points, {
        color: '#5f6368',
        weight: 4,
        opacity: 0.8,
        dashArray: '3 9',
        lineCap: 'round',
        lineJoin: 'round',
      })
        .bindTooltip(`Usual route: ${legLabel(leg)}`, { sticky: true, className: 'map-tooltip' })
        .addTo(layer);
      if (leg.affected) markAffected(points, layer, leg.affectedNote);
    }
  }, [baselineRoute]);

  // Origin/destination pins; when no route is shown, frame the pins instead.
  useEffect(() => {
    const map = mapRef.current;
    const layer = pinLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const points = [];

    if (origin?.latitude != null && origin?.longitude != null) {
      L.marker([origin.latitude, origin.longitude], { icon: pinIcon('origin'), zIndexOffset: 500 })
        .bindTooltip(origin.name || 'Origin', { className: 'map-tooltip' })
        .addTo(layer);
      points.push([origin.latitude, origin.longitude]);
    }
    if (destination?.latitude != null && destination?.longitude != null) {
      L.marker([destination.latitude, destination.longitude], { icon: pinIcon('destination'), zIndexOffset: 500 })
        .bindTooltip(destination.name || 'Destination', { className: 'map-tooltip' })
        .addTo(layer);
      points.push([destination.latitude, destination.longitude]);
    }

    if (!route && points.length > 0) {
      fitTargetRef.current = { bounds: L.latLngBounds(points), maxZoom: points.length === 1 ? 14 : 15 };
      userMovedRef.current = false;
      fitCurrentRef.current();
    }
  }, [origin, destination, route]);

  return (
    <div className="map-view">
      <div className="map-view__canvas" ref={containerRef} />
      {(route || baselineRoute) && (
        <div className={classNames('map-legend', !legendOpen && 'is-collapsed')}>
          <button
            type="button"
            className="map-legend__toggle"
            onClick={() => setLegendOpen((open) => !open)}
            aria-expanded={legendOpen}
          >
            Legend
            <span aria-hidden="true">{legendOpen ? '−' : '+'}</span>
          </button>
          {legendOpen && (
            <ul className="map-legend__list">
              <li><span className="map-legend__swatch map-legend__swatch--line" aria-hidden="true" />Route (solid)</li>
              <li><span className="map-legend__swatch map-legend__swatch--walk" aria-hidden="true" />Walking (dashed)</li>
              {baselineRoute && (
                <>
                  <li><span className="map-legend__swatch map-legend__swatch--baseline" aria-hidden="true" />Usual route (grey)</li>
                  <li><span className="map-legend__swatch map-legend__swatch--affected" aria-hidden="true" />⚠ Affected stretch</li>
                </>
              )}
            </ul>
          )}
        </div>
      )}
      {pickTarget && (
        <div className="map-view__hint">
          Click the map to set the <strong>{pickTarget === 'origin' ? 'origin' : 'destination'}</strong>
          <button type="button" className="map-view__hint-cancel" onClick={() => hoverRef.current?.(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

