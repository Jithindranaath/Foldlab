import { useRef, useState } from 'react';
import { useAppStore } from '../state/store.ts';

const ACCEPT = '*/*';

export default function Dropzone() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const loadFile = useAppStore((s) => s.loadFile);
  const loadSample = useAppStore((s) => s.loadSample);
  const dismissError = useAppStore((s) => s.dismissError);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null): void {
    const file = files?.[0];
    if (!file) return;
    void loadFile(file);
  }

  return (
    <div
      className="dropzone-overlay"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="glass dropzone" data-dragging={dragging}>
        <div className="dropzone-title">{status === 'artworkOnly' ? 'Artwork loaded' : 'Drop a dieline to begin'}</div>
        <div className="dropzone-hint">
          {status === 'artworkOnly'
            ? 'FoldLab looked for colored cut/crease lines in this image and didn’t find enough to build a fold, so it’s shown as artwork instead. It can still be mapped onto panels once a dieline is loaded.'
            : 'Any format works — PDF and SVG fold directly; PNG, JPG, and other images are traced for colored cut/crease lines automatically, or mapped on as artwork once a dieline is loaded.'}
        </div>

        {error && (
          <div className="dropzone-error">
            <strong>{error.title}.</strong> {error.detail}
          </div>
        )}

        <div className="dropzone-actions">
          <button type="button" className="glass-button" onClick={() => inputRef.current?.click()} disabled={status === 'parsing'}>
            Choose a file
          </button>
          <button type="button" className="glass-button" onClick={() => void loadSample()} disabled={status === 'parsing'}>
            Load the sample carton
          </button>
          {error && (
            <button type="button" className="glass-button" onClick={dismissError}>
              Dismiss
            </button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
