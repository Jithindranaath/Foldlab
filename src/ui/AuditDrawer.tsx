import type { AuditReport } from '../core/types.ts';
import { useAppStore } from '../state/store.ts';

interface Props {
  audit: AuditReport;
  onClose: () => void;
}

export default function AuditDrawer({ audit, onClose }: Props) {
  const rawCounts = useAppStore((s) => s.rawCounts);

  return (
    <div className="glass audit-drawer" role="dialog" aria-label="Audit">
      <div className="audit-drawer-header">
        <div className="panel-section-title audit-drawer-title">Audit</div>
        <button type="button" className="glass-button" onClick={onClose} aria-label="Close audit drawer">
          ✕
        </button>
      </div>

      <div className="audit-row">
        <span className="audit-row-label">Classification strategy</span>
        <span className="audit-row-value">{audit.classificationStrategy}</span>
      </div>

      {rawCounts && (
        <div className="audit-row">
          <span className="audit-row-label">Raw segments (straight / flattened curve)</span>
          <span className="audit-row-value">
            {rawCounts.straight + rawCounts.curve} ({rawCounts.straight} / {rawCounts.curve})
          </span>
        </div>
      )}

      <div className="audit-row">
        <span className="audit-row-label">Working segments (cut / crease / perf)</span>
        <span className="audit-row-value">
          {audit.segmentCounts.total} ({audit.segmentCounts.cut} / {audit.segmentCounts.crease} /{' '}
          {audit.segmentCounts.perf})
        </span>
      </div>

      <div className="audit-row">
        <span className="audit-row-label">Panels</span>
        <span className="audit-row-value">
          {audit.panelCount}
          {audit.expectedPanelCount !== null && ` — expected ${audit.expectedPanelCount}`}
        </span>
      </div>

      <div className="audit-row">
        <span className="audit-row-label">Derived L × H × D (mm)</span>
        <span className="audit-row-value">
          {round1(audit.dims.L)} × {round1(audit.dims.H)} × {round1(audit.dims.D)}
        </span>
      </div>

      <div className="audit-row">
        <span className="audit-row-label">Measured wall pair (mm)</span>
        <span className="audit-row-value">
          {round1(audit.dims.measuredPair[0])} / {round1(audit.dims.measuredPair[1])} — reconciled to D ={' '}
          {round1(audit.dims.D)}
        </span>
      </div>

      {audit.perimeterIdentity && (
        <div className="audit-row">
          <span className="audit-row-label">Perimeter identity</span>
          <span className={`audit-row-value ${audit.perimeterIdentity.holds ? 'audit-pass' : 'audit-warn'}`}>
            {round1(audit.perimeterIdentity.sumOfWidths)} = {round1(audit.perimeterIdentity.twiceAPlusB)}{' '}
            {audit.perimeterIdentity.holds ? '✓' : '⚠'}
          </span>
        </div>
      )}

      <div className="audit-row">
        <span className="audit-row-label">Closure residual (t=1)</span>
        <span className={`audit-row-value ${audit.closureResidualPass ? 'audit-pass' : 'audit-warn'}`}>
          {audit.closureResidualMm === null ? 'n/a' : `${audit.closureResidualMm.toFixed(3)} mm`}{' '}
          {audit.closureResidualMm !== null && (audit.closureResidualPass ? '✓' : '⚠')}
        </span>
      </div>
      {!audit.closureResidualPass && audit.closureResidualExplainedByCaliper && (
        <div className="audit-row">
          <span className="audit-row-label audit-row-note">
            Fully explained by the {round1(Math.abs(audit.dims.measuredPair[0] - audit.dims.measuredPair[1]))} mm
            wall-pair caliper gap above — not a parse error.
          </span>
        </div>
      )}

      <div className="audit-row">
        <span className="audit-row-label">Isometry drift (max)</span>
        <span className={`audit-row-value ${audit.isometryPass ? 'audit-pass' : 'audit-warn'}`}>
          {audit.isometryDriftMax === null ? 'n/a' : audit.isometryDriftMax.toExponential(2)}{' '}
          {audit.isometryDriftMax !== null && (audit.isometryPass ? '✓' : '⚠')}
        </span>
      </div>

      {audit.orphanPanels.length > 0 && (
        <div className="audit-row">
          <span className="audit-row-label">Disconnected panels</span>
          <span className="audit-row-value audit-warn">{audit.orphanPanels.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
