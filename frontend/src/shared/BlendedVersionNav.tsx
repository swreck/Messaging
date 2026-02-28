import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { StoryVersion } from '../types';

interface BlendedVersionNavProps {
  storyId: string;
  onRestore: () => void;
}

export function BlendedVersionNav({ storyId, onRestore }: BlendedVersionNavProps) {
  const [versions, setVersions] = useState<StoryVersion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);

  useEffect(() => {
    loadVersions();
  }, [storyId]);

  async function loadVersions() {
    try {
      const { versions: v } = await api.get<{ versions: StoryVersion[] }>(`/versions/story/${storyId}`);
      // Reverse so newest is last (they come desc from API)
      const sorted = [...v].reverse();
      setVersions(sorted);
      setCurrentIdx(sorted.length - 1);
    } catch {
      // ignore
    }
  }

  if (versions.length <= 0) return null;

  async function navigate(direction: -1 | 1) {
    const newIdx = currentIdx + direction;
    if (newIdx < 0 || newIdx >= versions.length) return;
    setCurrentIdx(newIdx);

    await api.post(`/versions/story/${storyId}/restore/${versions[newIdx].id}`);
    onRestore();
  }

  return (
    <div className="version-nav">
      <button onClick={() => navigate(-1)} disabled={currentIdx <= 0}>&lsaquo;</button>
      <span>v{currentIdx + 1}/{versions.length}</span>
      <button onClick={() => navigate(1)} disabled={currentIdx >= versions.length - 1}>&rsaquo;</button>
    </div>
  );
}
