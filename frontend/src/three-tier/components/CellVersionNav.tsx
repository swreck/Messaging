import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import type { CellVersion } from '../../types';

interface CellVersionNavProps {
  cellId: string;
  cellType: 'tier1' | 'tier2' | 'tier3';
  onRestore: (text: string) => void;
}

export function CellVersionNav({ cellId, cellType, onRestore }: CellVersionNavProps) {
  const [versions, setVersions] = useState<CellVersion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);

  useEffect(() => {
    loadVersions();
  }, [cellId]);

  async function loadVersions() {
    try {
      const { versions: v } = await api.get<{ versions: CellVersion[] }>(`/versions/cell/${cellType}/${cellId}`);
      setVersions(v);
      setCurrentIdx(v.length - 1);
    } catch {
      // ignore
    }
  }

  if (versions.length <= 1) return null;

  async function navigate(direction: -1 | 1) {
    const newIdx = currentIdx + direction;
    if (newIdx < 0 || newIdx >= versions.length) return;
    setCurrentIdx(newIdx);

    // Restore this version
    await api.post(`/versions/cell/${cellType}/${cellId}/restore/${versions[newIdx].versionNum}`);
    onRestore(versions[newIdx].text);
  }

  return (
    <div className="cell-version-nav">
      <button onClick={() => navigate(-1)} disabled={currentIdx <= 0}>&lsaquo;</button>
      <span>v{currentIdx + 1} of {versions.length}</span>
      <button onClick={() => navigate(1)} disabled={currentIdx >= versions.length - 1}>&rsaquo;</button>
    </div>
  );
}
