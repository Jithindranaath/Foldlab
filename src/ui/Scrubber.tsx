import { useAppStore } from '../state/store.ts';

export default function Scrubber() {
  const t = useAppStore((s) => s.t);
  const playing = useAppStore((s) => s.playing);
  const setT = useAppStore((s) => s.setT);
  const play = useAppStore((s) => s.play);
  const pause = useAppStore((s) => s.pause);
  const reset = useAppStore((s) => s.reset);
  const show = useAppStore((s) => s.show);
  const toggleShow = useAppStore((s) => s.toggleShow);
  const schedule = useAppStore((s) => s.schedule);

  const disabled = schedule === null;

  return (
    <div className="glass scrubber-bar">
      <div className="scrubber-track-wrap">
        <span className="scrubber-label">FLAT</span>
        <input
          type="range"
          className="scrubber-input"
          min={0}
          max={1}
          step={0.001}
          value={t}
          disabled={disabled}
          style={{ ['--progress' as string]: t }}
          onChange={(e) => setT(parseFloat(e.target.value))}
          aria-label="Fold progress"
        />
        <span className="scrubber-label">CLOSED</span>
        <span className="t-readout">t = {t.toFixed(2)}</span>
      </div>

      <div className="transport-controls">
        <div className="transport-group">
          <button
            type="button"
            className="glass-button glass-button-primary"
            disabled={disabled}
            onClick={() => (playing ? pause() : play())}
          >
            {playing ? '⏸ Pause' : '▶ Fold'}
          </button>
          <button type="button" className="glass-button" disabled={disabled} onClick={reset}>
            ↺ Reset
          </button>
        </div>

        <div className="transport-divider" aria-hidden="true" />

        <div className="transport-group">
          <button
            type="button"
            className="glass-button"
            data-active={show.frames}
            onClick={() => toggleShow('frames')}
          >
            ◱ Frames
          </button>
          <button type="button" className="glass-button" data-active={show.grid} onClick={() => toggleShow('grid')}>
            ◈ Grid
          </button>
          <button type="button" className="glass-button" data-active={show.axes} onClick={() => toggleShow('axes')}>
            ⟠ Axes
          </button>
          <button type="button" className="glass-button" data-active={show.dims} onClick={() => toggleShow('dims')}>
            ⇕ Dims
          </button>
        </div>
      </div>
    </div>
  );
}
