import { Modal } from '../../shared/Modal';

interface SnapshotData {
  tier1: string;
  tier2: { text: string; categoryLabel?: string; tier3: string[] }[];
}

interface CompareModalProps {
  open: boolean;
  onClose: () => void;
  snapshot: SnapshotData;
  current: SnapshotData;
  snapshotLabel: string;
}

function cellStyle(changed: boolean): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    lineHeight: 1.4,
    background: changed ? '#fff3cd' : 'white',
    border: '1px solid var(--border, #e5e7eb)',
    borderRadius: 4,
    minHeight: 32,
  };
}

export function CompareModal({ open, onClose, snapshot, current, snapshotLabel }: CompareModalProps) {
  const maxCols = Math.max(snapshot.tier2.length, current.tier2.length);
  const tier1Changed = snapshot.tier1 !== current.tier1;

  return (
    <Modal open={open} onClose={onClose} title={`Compare: ${snapshotLabel} vs. Current`} className="compare-modal-overlay">
      <div className="compare-container">
        {/* Header row */}
        <div className="compare-row compare-header-row">
          <div className="compare-label" />
          <div className="compare-col-header">Snapshot</div>
          <div className="compare-col-header">Current</div>
        </div>

        {/* Tier 1 */}
        <div className="compare-row">
          <div className="compare-label">Tier 1</div>
          <div style={cellStyle(tier1Changed)}>{snapshot.tier1 || '(empty)'}</div>
          <div style={cellStyle(tier1Changed)}>{current.tier1 || '(empty)'}</div>
        </div>

        {/* Tier 2 columns */}
        {Array.from({ length: maxCols }).map((_, i) => {
          const snapT2 = snapshot.tier2[i];
          const currT2 = current.tier2[i];
          const t2Changed = (snapT2?.text || '') !== (currT2?.text || '');
          const snapT3 = snapT2?.tier3 || [];
          const currT3 = currT2?.tier3 || [];
          const maxBullets = Math.max(snapT3.length, currT3.length);
          const label = currT2?.categoryLabel || snapT2?.categoryLabel || `Column ${i + 1}`;

          return (
            <div key={i} className="compare-section">
              <div className="compare-row">
                <div className="compare-label">Tier 2: {label}</div>
                <div style={cellStyle(t2Changed)}>{snapT2?.text || '(empty)'}</div>
                <div style={cellStyle(t2Changed)}>{currT2?.text || '(empty)'}</div>
              </div>
              {maxBullets > 0 && Array.from({ length: maxBullets }).map((_, j) => {
                const snapBullet = snapT3[j] || '';
                const currBullet = currT3[j] || '';
                const bulletChanged = snapBullet !== currBullet;
                return (
                  <div key={j} className="compare-row compare-row-tier3">
                    <div className="compare-label compare-label-indent">Tier 3 #{j + 1}</div>
                    <div style={cellStyle(bulletChanged)}>{snapBullet || '(empty)'}</div>
                    <div style={cellStyle(bulletChanged)}>{currBullet || '(empty)'}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
