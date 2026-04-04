import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import type { CellVersion } from '../../types';

interface CellVersionNavProps {
  cellId: string;
  cellType: 'tier1' | 'tier2' | 'tier3';
  currentText?: string; // Pass current text to detect when to refresh
  draftVersion?: number; // Draft version number — triggers re-fetch on any draft change (e.g. Maria edits)
  onRestore: (text: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ai_generate: 'generated',
  manual: 'your edit',
  review: 'Maria\u2019s suggestion',
  refine: 'refined',
  ai_regenerate: 'regenerated',
  direction: 'Maria\u2019s direction',
};

export function CellVersionNav({ cellId, cellType, currentText, draftVersion, onRestore }: CellVersionNavProps) {
  const [versions, setVersions] = useState<CellVersion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [previewing, setPreviewing] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(-1);

  useEffect(() => {
    loadVersions();
  }, [cellId, currentText, draftVersion]); // Refresh when text or draft version changes

  async function loadVersions() {
    try {
      const { versions: v } = await api.get<{ versions: CellVersion[] }>(`/versions/cell/${cellType}/${cellId}`);
      setVersions(v);
      setCurrentIdx(v.length - 1);
      setPreviewing(false);
      setPreviewIdx(-1);
    } catch {
      // ignore
    }
  }

  // Reserve space even when no versions to show (keeps TIER 3 aligned across columns)
  if (versions.length <= 1) return <div className="cell-version-nav" />;
  const uniqueTexts = new Set(versions.map(v => v.text));
  if (uniqueTexts.size <= 1) return <div className="cell-version-nav" />;

  const displayIdx = previewing ? previewIdx : currentIdx;
  const displayVersion = versions[displayIdx];
  const sourceLabel = displayVersion ? (SOURCE_LABELS[displayVersion.changeSource] || displayVersion.changeSource) : '';

  function startPreview(direction: -1 | 1) {
    const baseIdx = previewing ? previewIdx : currentIdx;
    const newIdx = baseIdx + direction;
    if (newIdx < 0 || newIdx >= versions.length) return;

    if (!previewing) {
      setPreviewing(true);
    }
    setPreviewIdx(newIdx);
  }

  async function useThisVersion() {
    if (!previewing || previewIdx < 0) return;
    const version = versions[previewIdx];
    // Restore creates a new version entry (timeline grows)
    await api.post(`/versions/cell/${cellType}/${cellId}/restore/${version.versionNum}`);
    onRestore(version.text);
    setPreviewing(false);
    setPreviewIdx(-1);
    loadVersions();
  }

  function cancelPreview() {
    setPreviewing(false);
    setPreviewIdx(-1);
  }

  return (
    <div className={`cell-version-nav${previewing ? ' version-previewing' : ''}`}>
      <button
        onClick={() => startPreview(-1)}
        disabled={displayIdx <= 0}
        title="Earlier version"
      >&lsaquo;</button>
      <span className="cell-version-label">
        v{displayIdx + 1}{versions.length > 1 ? ` of ${versions.length}` : ''}
        {sourceLabel && versions.length > 1 && <span className="cell-version-source"> — {sourceLabel}</span>}
      </span>
      <button
        onClick={() => startPreview(1)}
        disabled={displayIdx >= versions.length - 1}
        title="Later version"
      >&rsaquo;</button>
      {previewing && (
        <span className="cell-version-preview-actions">
          <button className="cell-version-use" onClick={useThisVersion}>Use this</button>
          <button className="cell-version-cancel" onClick={cancelPreview}>Cancel</button>
        </span>
      )}
      {previewing && versions[previewIdx] && versions[previewIdx].text !== versions[currentIdx]?.text && (
        <div className="cell-version-preview-text">
          {versions[previewIdx].text}
        </div>
      )}
    </div>
  );
}
