import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BASEMAP_STYLES, LEG_COLOURS, ONEMAP_ATTRIBUTION, lineSwatchColour } from '../lib/constants.js';
import { classNames, legLabel } from '../lib/format.js';

const SINGAPORE_CENTER = [1.3521, 103.8198];
const TILE_URL = 'https://tile.openstreetmap.org';

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

/**
 * OneMap basemap with the selected route drawn leg by leg. Bus legs are cyan,
 * MRT legs blue, walks a dashed grey; the active leg (clicked in the timeline
 * or on the map) is drawn thicker and its stops get dots. Clicking the map
 * reports the point back to the app so it can fill the origin or destination.
 */
export function MapView({
  origin,
  destination,
  route,
  activeLegId,
  onLegHover,
  onPickPoint,
  pickTarget,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const tileRef = useRef(null);
  const routeLayerRef = useRef(null);
  const pinLayerRef = useRef(null);
  const pickRef = useRef(onPickPoint);
  const hoverRef = useRef(onLegHover);
  const fittedForRef = useRef(null);
  const [basemap, setBasemap] = useState('Default');

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
    tileRef.current = L.tileLayer(`${TILE_URL}/Default/{z}/{x}/{y}.png`, {
      maxZoom: 19,
      attribution: ONEMAP_ATTRIBUTION,
    }).addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    pinLayerRef.current = L.layerGroup().addTo(map);
    map.on('click', (event) => {
      pickRef.current?.({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    });
    mapRef.current = map;
    const resize = setTimeout(() => map.invalidateSize(), 60);
    return () => {
      clearTimeout(resize);
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      routeLayerRef.current = null;
      pinLayerRef.current = null;
    };
  }, []);

  // Switch basemap styles without recreating the map.
  useEffect(() => {
    tileRef.current?.setUrl(`${TILE_URL}/{z}/{x}/{y}.png`);
  }, [basemap]);

  // Draw the selected route: one polyline per leg, dots for the active leg's stops.
  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = [];

    for (const leg of route?.legs || []) {
      const points = (leg.geometry || [])
        .map(([lat, lng]) => [Number(lat), Number(lng)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (points.length < 2 && leg.from?.latitude != null && leg.to?.latitude != null) {
        points.push([leg.from.latitude, leg.from.longitude], [leg.to.latitude, leg.to.longitude]);
      }
      if (points.length < 2) continue;

      const isActive = leg.id === activeLegId;
      const line = L.polyline(points, {
        color: leg.type === 'mrt' ? lineSwatchColour(leg.line) : (LEG_COLOURS[leg.type] || LEG_COLOURS.other),
        weight: isActive ? 9 : 5,
        opacity: activeLegId && !isActive ? 0.35 : 0.9,
        dashArray: leg.type === 'walk' ? '2 7' : undefined,
        lineCap: 'round',
        lineJoin: 'round',
      });
      line.bindTooltip(legLabel(leg), { sticky: true, className: 'map-tooltip' });
      line.on('click', () => hoverRef.current?.(leg.id));
      line.addTo(layer);
      for (const point of points) bounds.push(point);

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
      map.fitBounds(L.latLngBounds(bounds), { padding: [34, 34], maxZoom: 15 });
    }
  }, [route, activeLegId]);

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

    if (!route && points.length === 1) {
      map.setView(points[0], 14);
    } else if (!route && points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
    }
  }, [origin, destination, route]);

  return (
    <div className="map-view">
      <div className="map-view__canvas" ref={containerRef} />
      <div className="map-view__tools" role="group" aria-label="Basemap style">
        {BASEMAP_STYLES.map((style) => (
          <button
            key={style.value}
            type="button"
            className={classNames('map-style__button', basemap === style.value && 'is-active')}
            onClick={() => setBasemap(style.value)}
          >
            {style.label}
          </button>
        ))}
      </div>
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

