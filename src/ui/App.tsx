import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../state/store.ts';
import TopBar from './TopBar.tsx';
import Dropzone from './Dropzone.tsx';
import DielineView from './DielineView.tsx';
import Scrubber from './Scrubber.tsx';
import AuditDrawer from './AuditDrawer.tsx';
import Viewport3D from './Viewport3D.tsx';

const FOLD_DURATION_MS = 5200;

export default function App() {
  const status = useAppStore((s) => s.status);
  const schedule = useAppStore((s) => s.schedule);
  const audit = useAppStore((s) => s.audit);
  const artworkBitmapUrl = useAppStore((s) => s.artworkBitmapUrl);
  const playing = useAppStore((s) => s.playing);
  const setT = useAppStore((s) => s.setT);
  const pause = useAppStore((s) => s.pause);
  const play = useAppStore((s) => s.play);
  const reset = useAppStore((s) => s.reset);

  const [auditOpen, setAuditOpen] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }
    function tick(ts: number): void {
      if (lastTsRef.current === null) lastTsRef.current = ts;
      const dt = ts - lastTsRef.current;
      lastTsRef.current = ts;
      const next = useAppStore.getState().t + dt / FOLD_DURATION_MS;
      if (next >= 1) {
        setT(1);
        pause();
      } else {
        setT(next);
        rafRef.current = requestAnimationFrame(tick);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, setT, pause]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const active = document.activeElement;
      const isTextInput = active instanceof HTMLInputElement && active.type !== 'range';
      if (isTextInput) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (useAppStore.getState().schedule) {
          playing ? pause() : play();
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setT(Math.min(1, useAppStore.getState().t + 0.02));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setT(Math.max(0, useAppStore.getState().t - 0.02));
      } else if (e.key === 'r' || e.key === 'R') {
        reset();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playing, pause, play, setT, reset]);

  const showDropzone = status === 'idle' || status === 'error' || status === 'artworkOnly';

  return (
    <div className="app-shell">
      <div className="bg-ambient" />
      <TopBar auditOpen={auditOpen} onToggleAudit={() => setAuditOpen((v) => !v)} />

      <div className="main-area">
        <div className="glass dieline-panel">
          <div className="dieline-panel-scroll">
            {schedule ? (
              <DielineView schedule={schedule} />
            ) : (
              <div className="dropzone-hint">The 2D dieline will appear here once a file loads.</div>
            )}
          </div>
        </div>

        <div className="viewport-area">
          <Viewport3D />

          {artworkBitmapUrl && status === 'artworkOnly' && (
            <img
              src={artworkBitmapUrl}
              alt="Uploaded artwork preview"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                padding: 40,
                opacity: 0.9
              }}
            />
          )}

          {showDropzone && <Dropzone />}

          {audit && (
            <div className="audit-badge glass">
              <span
                className="audit-badge-dot"
                data-pass={(audit.closureResidualPass || audit.closureResidualExplainedByCaliper) && audit.isometryPass}
              >
                {(audit.closureResidualPass || audit.closureResidualExplainedByCaliper) && audit.isometryPass
                  ? '✓'
                  : '⚠'}
              </span>
              closure {audit.closureResidualMm?.toFixed(2) ?? 'n/a'} mm
            </div>
          )}

          {auditOpen && audit && <AuditDrawer audit={audit} onClose={() => setAuditOpen(false)} />}
        </div>
      </div>

      <Scrubber />
    </div>
  );
}
