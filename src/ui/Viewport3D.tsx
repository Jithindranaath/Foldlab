import { useEffect, useRef, useState } from 'react';
import { Viewport } from '../three/Viewport.ts';
import { useAppStore } from '../state/store.ts';

export default function Viewport3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [openedPanelId, setOpenedPanelId] = useState<string | null>(null);
  // A pure CSS opacity fade on the canvas element itself when a new sheet
  // appears — a compositor-level fade with zero effect on the 3D scene's
  // own materials or draw order, so it can't introduce the kind of
  // rendering artifact a WebGL-side fade risks mid-fold.
  const [revealed, setRevealed] = useState(false);

  const schedule = useAppStore((s) => s.schedule);
  const t = useAppStore((s) => s.t);
  const show = useAppStore((s) => s.show);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewport = new Viewport(host);
    viewport.setOnOpenedPanelChange(setOpenedPanelId);
    viewportRef.current = viewport;
    return () => {
      viewport.setOnOpenedPanelChange(null);
      viewport.dispose();
      viewportRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!schedule || !viewportRef.current) return;
    viewportRef.current.loadSchedule(schedule);
    setOpenedPanelId(null);
    setRevealed(false);
    const raf = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(raf);
  }, [schedule]);

  useEffect(() => {
    viewportRef.current?.setFoldParameter(t);
  }, [t]);

  useEffect(() => {
    viewportRef.current?.setShow(show);
  }, [show]);

  return (
    <>
      <div
        ref={hostRef}
        className="viewport-canvas-host"
        style={{ opacity: revealed ? 1 : 0, transition: 'opacity 450ms ease' }}
      />
      {openedPanelId && (
        <button
          type="button"
          className="glass-button panel-open-badge"
          onClick={() => viewportRef.current?.closeOpenedPanel()}
        >
          ✕ Close
        </button>
      )}
    </>
  );
}
