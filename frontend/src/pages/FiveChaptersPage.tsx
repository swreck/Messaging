import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { InfoTooltip } from '../shared/InfoTooltip';
import { ConfirmModal } from '../shared/ConfirmModal';
import { useMaria } from '../shared/MariaContext';
import { useToast } from '../shared/ToastContext';
import { MEDIUM_OPTIONS } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  audiences: {
    id: string;
    name: string;
    threeTier: { id: string; status: string; currentStep: number };
    deliverables: { id: string; medium: string; customName: string; stage: string; updatedAt: string }[];
  }[];
}

export function FiveChaptersPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteStoryId, setDeleteStoryId] = useState<string | null>(null);

  async function handleDeleteStory() {
    if (!deleteStoryId) return;
    try {
      await api.delete(`/stories/${deleteStoryId}`);
      setDeleteStoryId(null);
      loadData();
    } catch { showToast('Could not delete deliverable'); setDeleteStoryId(null); }
  }

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'five-chapters' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    if (hierarchy.length === 0) setLoading(true);
    try {
      const { hierarchy } = await api.get<{ hierarchy: HierarchyOffering[] }>('/drafts/hierarchy');
      setHierarchy(hierarchy);
    } finally {
      setLoading(false);
    }
  }

  function getMediumLabel(medium: string): string {
    const standard = MEDIUM_OPTIONS.find(m => m.id === medium);
    if (standard) return standard.label;
    // Custom deliverable — truncate at first em-dash, period, or 35 chars
    const short = medium.split(/\s*[—.]\s*/)[0].trim();
    return short.length > 35 ? short.substring(0, 32) + '...' : short;
  }

  function getStageLabel(stage: string): string {
    if (stage === 'blended') return 'Complete Draft';
    if (stage === 'joined') return 'Combined Draft';
    return 'Draft Chapters';
  }

  function getStageDescription(stage: string): string {
    if (stage === 'blended') return 'Automatically revised with transitions and smooth language for a strong first draft of your message.';
    if (stage === 'joined') return 'Chapters put together without further automated edits, so you can see how they hold together. You can edit here too.';
    return 'Each of the 5 chapters created individually, so you can review and edit before combining.';
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
    deliverables: { id: string; medium: string; customName: string; stage: string; updatedAt: string }[];
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
        <div>
          <h1>5 Chapter Stories</h1>
          <p className="page-description">Stories built from your Three Tiers</p>
        </div>
      </header>

      {!hasAnyContent && (
        <div className="empty-state empty-state-enhanced">
          <div className="empty-icon">📖</div>
          <h3>Stories come from your Three Tier</h3>
          <p>Once you've built a Three Tier message, Maria can turn it into an email, a pitch, a blog post — whatever you need. Start there first.</p>
          <button className="btn btn-primary" onClick={() => navigate('/three-tiers')} style={{ marginTop: 16 }}>Go to Three Tiers</button>
        </div>
      )}

      {groups.map(group => (
        <section key={`${group.offeringName}-${group.audienceName}`} className="fcs-group">
          <h2 className="fcs-group-audience">{group.audienceName}</h2>
          <h3 className="fcs-group-offering">{group.offeringName}</h3>

          {!group.isComplete ? (
            <div className="fcs-hint" style={{ cursor: 'pointer' }} onClick={() => navigate(`/three-tier/${group.draftId}`)}>
              Three Tier {group.status === 'in_progress' ? `in progress (Step ${group.currentStep})` : 'not yet started'} — <span style={{ color: 'var(--accent)', textDecoration: 'underline' }}>finish it</span> to generate stories.
            </div>
          ) : (
            <div className="tt-card-grid">
              {(() => {
                const mediumCounts = new Map<string, number>();
                const mediumTotals = new Map<string, number>();
                for (const d of group.deliverables) {
                  mediumTotals.set(d.medium, (mediumTotals.get(d.medium) || 0) + 1);
                }
                return group.deliverables.map(del => {
                  const count = (mediumCounts.get(del.medium) || 0) + 1;
                  mediumCounts.set(del.medium, count);
                  const total = mediumTotals.get(del.medium) || 1;
                  const fallbackName = total > 1
                    ? `${getMediumLabel(del.medium)} #${count}`
                    : getMediumLabel(del.medium);
                  const displayName = del.customName || fallbackName;
                  return (
                    <div
                      key={del.id}
                      className="tt-card"
                      onClick={() => navigate(`/five-chapter/${group.draftId}`)}
                    >
                      <div className="tt-card-name">{displayName}</div>
                      <div className="tt-card-progress">
                        <span className="fcs-stage-icon">{getStageIcon(del.stage)}</span>
                        <span className="tt-card-status">{getStageLabel(del.stage)}</span>
                        <InfoTooltip text={getStageDescription(del.stage)} />
                      </div>
                      <div className="tt-card-updated">{formatUpdatedAt(del.updatedAt)}</div>
                      <div className="tt-card-action" style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost btn-sm">
                          {del.stage === 'blended' ? 'Open' : 'Continue'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--danger)' }}
                          onClick={(e) => { e.stopPropagation(); setDeleteStoryId(del.id); }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                });
              })()}

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
      <ConfirmModal
        open={!!deleteStoryId}
        onClose={() => setDeleteStoryId(null)}
        onConfirm={handleDeleteStory}
        title="Delete this deliverable?"
        message="This will permanently delete this deliverable and all its chapters. This cannot be undone."
        confirmLabel="Delete"
        confirmDanger
      />
    </div>
  );
}
