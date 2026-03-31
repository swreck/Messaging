import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '../shared/Spinner';

interface SharedThreeTier {
  type: 'three-tier';
  offering: string;
  audience: string;
  tier1: string;
  tier2: { categoryLabel: string; text: string; tier3: string[] }[];
}

interface SharedFiveChapter {
  type: 'five-chapter';
  offering: string;
  audience: string;
  medium: string;
  cta: string;
  blendedText: string | null;
  chapters: { chapterNum: number; title: string; content: string }[];
}

type SharedData = SharedThreeTier | SharedFiveChapter;

export function SharedView() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/share/${token}`)
      .then(res => {
        if (!res.ok) throw new Error('Link not found or expired');
        return res.json();
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size={32} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ textAlign: 'center', color: '#6e6e73' }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Link not found</h2>
          <p>{error || 'This share link may have expired or been removed.'}</p>
        </div>
      </div>
    );
  }

  if (data.type === 'three-tier') {
    return (
      <div className="shared-view">
        <div className="shared-header">
          <h1>Three Tier Message</h1>
          <p className="shared-meta">{data.offering} &rarr; {data.audience}</p>
        </div>
        <div className="shared-tier1">{data.tier1}</div>
        <div className="shared-tier2-grid" style={{ gridTemplateColumns: `repeat(${data.tier2.length}, 1fr)` }}>
          {data.tier2.map((t2, i) => (
            <div key={i} className="shared-tier2-col">
              {t2.categoryLabel && (
                <div className="shared-tier2-label">{t2.categoryLabel}</div>
              )}
              <div className="shared-tier2-text">{t2.text}</div>
              <ul className="shared-tier3-list">
                {t2.tier3.map((t3, j) => (
                  <li key={j}>{t3}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Five Chapter
  const content = data.blendedText || data.chapters.map(c => c.content).join('\n\n');
  return (
    <div className="shared-view">
      <div className="shared-header">
        <h1>Five Chapter Story</h1>
        <p className="shared-meta">{data.offering} &rarr; {data.audience} &middot; {data.medium}</p>
      </div>
      <div className="shared-story-content">{content}</div>
    </div>
  );
}
