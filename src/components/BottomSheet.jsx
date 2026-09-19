import { useEffect, useRef, useState } from 'react';
import { classNames } from '../lib/format.js';

/**
 * Draggable bottom sheet for mobile (see the max-width:960px block in
 * styles.css) wrapping the existing .app__panel content unchanged. On
 * desktop `.sheet` is `display: contents`, so it has no box of its own and
 * `.app__panel` behaves exactly as it always did as a plain grid column -
 * the drag handlers below simply never fire there (the handle is hidden).
 *
 * Two snap points - "peek" (tall enough for the planner form) and "full"
 * (nearly the whole viewport, for the route list). Drag the handle, tap it
 * to toggle, or release past the midpoint to snap to the nearer one.
 */
export function BottomSheet({ children, openKey, onInsetChange }) {
  const [snap, setSnap] = useState('peek');
  const [liveHeight, setLiveHeight] = useState(null);
  // Whether the sheet is actually laid over the map (phone layout) rather than
  // being a plain side column (desktop, where `.sheet` is `display: contents`).
  const [overlay, setOverlay] = useState(false);
  // Bounds live in state, not a ref: they must trigger a re-render when the
  // viewport changes (rotation, or the soft keyboard opening/closing via
  // visualViewport) so the sheet's rendered height - read during render
  // below - actually follows, instead of only updating lazily on the next
  // unrelated interaction.
  const [bounds, setBounds] = useState({ peek: 320, full: 600, min: 96 });
  const sheetRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // The sheet lives inside the main area (below the header, the "Today" card and
  // any banners), so its bounds come from that area, not the whole viewport:
  // fully open it fills the map area but never covers the chrome above it,
  // and it follows the area as banners appear and disappear.
  useEffect(() => {
    const host = sheetRef.current?.parentElement;
    function measure() {
      if (!host) return;
      setOverlay(getComputedStyle(sheetRef.current).position === 'absolute');
      const visible = window.visualViewport
        ? window.visualViewport.height - host.getBoundingClientRect().top
        : Infinity;
      const available = Math.max(160, Math.min(host.clientHeight, visible));
      setBounds({ peek: Math.min(360, available * 0.55), full: available, min: 96 });
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer && host) observer.observe(host);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);

  // Nudges the sheet open once per new value of `openKey` (e.g. a fresh
  // plan's timestamp) so results are visible without a manual drag, without
  // fighting a manual collapse the user makes afterward - the effect only
  // re-fires when the key itself changes, not on every render.
  useEffect(() => {
    if (openKey) setSnap('full');
  }, [openKey]);

  const restHeight = bounds[snap === 'full' ? 'full' : 'peek'];
  const height = liveHeight ?? restHeight;

  // Tell the app how much of the map's bottom the sheet covers when it settles
  // (not while it is being dragged), so the map can frame the route above it.
  useEffect(() => {
    onInsetChange?.(overlay ? restHeight : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, restHeight]);

  // Publish the sheet's height on the shared parent so the map can lift its
  // bottom controls (the required OpenStreetMap attribution) above the sheet
  // instead of being hidden behind it.
  useEffect(() => {
    const host = sheetRef.current?.parentElement;
    if (!host) return undefined;
    host.style.setProperty('--sheet-offset', `${height}px`);
    return () => host.style.removeProperty('--sheet-offset');
  }, [height]);

  const onHandlePointerDown = (event) => {
    dragRef.current = { startY: event.clientY, startHeight: restHeight };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHandlePointerMove = (event) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startY - event.clientY; // dragging up = growing
    if (Math.abs(delta) > 4) movedRef.current = true;
    // Reads the ref (kept in sync with state above) rather than `bounds`
    // directly, since this handler closure is captured once per pointerdown
    // and shouldn't go stale if the viewport changes mid-drag.
    const { full, min } = boundsRef.current;
    setLiveHeight(Math.min(full, Math.max(min, dragRef.current.startHeight + delta)));
  };

  const onHandlePointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const { peek, full } = boundsRef.current;
    const settled = liveHeight ?? restHeight;
    setSnap(settled > (peek + full) / 2 ? 'full' : 'peek');
    setLiveHeight(null);
  };

  const handleClick = () => {
    if (!movedRef.current) setSnap((current) => (current === 'full' ? 'peek' : 'full'));
  };

  return (
    <div
      ref={sheetRef}
      className={classNames('sheet', snap === 'full' && 'sheet--full', liveHeight !== null && 'sheet--dragging')}
      style={{ '--sheet-height': `${height}px` }}
    >
      <button
        type="button"
        className="sheet__handle"
        aria-expanded={snap === 'full'}
        aria-label={snap === 'full' ? 'Collapse route panel' : 'Expand route panel'}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onClick={handleClick}
      >
        <span className="sheet__grip" aria-hidden="true" />
      </button>
      <section className="app__panel">{children}</section>
    </div>
  );
}
