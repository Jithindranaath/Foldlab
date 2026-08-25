import { useAppStore } from '../state/store.ts';

interface Props {
  auditOpen: boolean;
  onToggleAudit: () => void;
}

export default function TopBar({ auditOpen, onToggleAudit }: Props) {
  const fileName = useAppStore((s) => s.fileName);
  const status = useAppStore((s) => s.status);
  const loadSample = useAppStore((s) => s.loadSample);

  return (
    <div className="glass top-bar">
      <div className="brand">
        <span className="brand-mark">◇</span> FOLDLAB
      </div>
      {fileName && <div className="top-bar-filename">{fileName}</div>}
      <div className="top-bar-spacer" />
      <button type="button" className="glass-button" onClick={() => void loadSample()} disabled={status === 'parsing'}>
        Load the sample carton
      </button>
      <button
        type="button"
        className="glass-button glass-button-panel-toggle"
        data-active={auditOpen}
        aria-expanded={auditOpen}
        onClick={onToggleAudit}
      >
        Audit {auditOpen ? '▴' : '▾'}
      </button>
    </div>
  );
}
