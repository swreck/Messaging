import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { ChapterVersion } from '../types';

interface ChapterVersionNavProps {
  chapterContentId: string;
  onRestore: (content: string) => void;
}

export function ChapterVersionNav({ chapterContentId, onRestore }: ChapterVersionNavProps) {
  const [versions, setVersions] = useState<ChapterVersion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);

  useEffect(() => {
    loadVersions();
  }, [chapterContentId]);

  async function loadVersions() {
    try {
      const { versions: v } = await api.get<{ versions: ChapterVersion[] }>(`/versions/chapter/${chapterContentId}`);
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

    await api.post(`/versions/chapter/${chapterContentId}/restore/${versions[newIdx].versionNum}`);
    onRestore(versions[newIdx].content);
  }

  const SOURCE_LABELS: Record<string, string> = {
    ai_generate: 'generated',
    manual: 'your edit',
    refine: 'refined',
    personalized: 'personalized',
    poetry_pass: 'polished',
    magic_hour: 'magic hour',
  };

  const currentSource = versions[currentIdx]?.changeSource;
  const sourceLabel = currentSource ? SOURCE_LABELS[currentSource] || currentSource : '';

  return (
    <div className="version-nav">
      <button onClick={() => navigate(-1)} disabled={currentIdx <= 0}>&lsaquo;</button>
      <span>v{currentIdx + 1}/{versions.length}{sourceLabel ? ` (${sourceLabel})` : ''}</span>
      <button onClick={() => navigate(1)} disabled={currentIdx >= versions.length - 1}>&rsaquo;</button>
    </div>
  );
}
