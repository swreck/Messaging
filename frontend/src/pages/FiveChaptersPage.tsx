import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { MEDIUM_OPTIONS } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  audiences: {
    id: string;
    name: string;
    threeTier: { id: string; status: string; currentStep: number };
    deliverables: { id: string; medium: string; stage: string; updatedAt: string }[];
  }[];
}

export function FiveChaptersPage() {
  const navigate = useNavigate();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [loading, setLoading] = useState(true);

  const { setPageContext } = useMaria();
  useEffect(() => { setPageContext({ page: 'five-chapters' }); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const { hierarchy } = await api.get<{ hierarchy: HierarchyOffering[] }>('/drafts/hierarchy');
      setHierarchy(hierarchy);
    } finally {
      setLoading(false);
    }
  }

  function getMediumLabel(medium: string): string {
    return MEDIUM_OPTIONS.find(m => m.id === medium)?.label || medium;
  }

  function getStageLabel(stage: string): string {
    if (stage === 'blended') return 'Blended';
    if (stage === 'joined') return 'Joined';
    return 'Chapters';
  }

  function getStageIcon(stage: string): string {
    if (stage === 'blended') return '\u2713';
    if (stage === 'joined') return '\u25D0';
    return '\u25CB';
  }

  function formatUpdatedAt(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return 'Updated just now';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Updated ${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `Updated ${days}d ago`;
    const weeks = Math.floor(days / 7);
    return `Updated ${weeks}w ago`;
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  // Flatten hierarchy into offering → audience groups
  const groups: {
    offeringName: string;
    audienceName: string;
    draftId: string;
    isComplete: boolean;
    currentStep: number;
    status: string;
    deliverables: { id: string; medium: string; stage: string; updatedAt: string }[];
  }[] = [];

  for (const offering of hierarchy) {
    for (const aud of offering.audiences) {
      groups.push({
        offeringName: offering.name,
        audienceName: aud.name,
        draftId: aud.threeTier.id,
        isComplete: aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5,
        currentStep: aud.threeTier.currentStep,
        status: aud.threeTier.status,
        deliverables: aud.deliverables,
      });
    }
  }

  const hasAnyContent = groups.length > 0;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Five Chapter Stories</h1>
        <p className="page-description">Narrative stories generated from completed Three Tier messages</p>
      </header>

      {!hasAnyContent && (
        <div className="empty-state">
          <h2 style={{ marginBottom: 8 }}>No stories yet</h2>
          <p>Complete a Three Tier message first, then you can generate Five Chapter stories from it.</p>
          <button className="btn btn-secondary" onClick={() => navigate('/three-tiers')} style={{ marginTop: 16 }}>Go to Three Tiers</button>
        </div>
      )}

      {groups.map(group => (
        <section key={`${group.offeringName}-${group.audienceName}`} className="fcs-group">
          <h2 className="fcs-group-name">{group.offeringName} &rarr; {group.audienceName}</h2>

          {!group.isComplete ? (
            <div className="fcs-hint">
              Three Tier {group.status === 'in_progress' ? `in progress (Step ${group.currentStep})` : 'not yet started'} — complete it to generate stories.
            </div>
          ) : (
            <div className="tt-card-grid">
              {group.deliverables.map(del => (
                <div
                  key={del.id}
                  className="tt-card"
                  onClick={() => navigate(`/five-chapter/${group.draftId}`)}
                >
                  <div className="tt-card-name">{getMediumLabel(del.medium)}</div>
                  <div className="tt-card-progress">
                    <span className="fcs-stage-icon">{getStageIcon(del.stage)}</span>
                    <span className="tt-card-status">{getStageLabel(del.stage)}</span>
                  </div>
                  <div className="tt-card-updated">{formatUpdatedAt(del.updatedAt)}</div>
                  <div className="tt-card-action">
                    <button className="btn btn-ghost btn-sm">
                      {del.stage === 'blended' ? 'Open' : 'Continue'}
                    </button>
                  </div>
                </div>
              ))}

              <div
                className="tt-card tt-card-new"
                onClick={() => navigate(`/five-chapter/${group.draftId}`)}
              >
                <span className="tt-card-new-icon">+</span>
                <span className="tt-card-new-label">New Deliverable</span>
              </div>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
