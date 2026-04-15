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
    const short = medium.split(/\s*[—.]\s*/)[0].trim();
    return short.length > 35 ? short.substring(0, 32) + '...' : short;
  }

  function getStageLabel(stage: string): string {
    if (stage === 'personalized') return 'Personalized';
    if (stage === 'polished') return 'Polished';
    if (stage === 'blended') return 'Blended';
    if (stage === 'joined') return 'Combined';
    return 'Chapters';
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

  // Reorganize: audience → offering pairs with ready Three Tiers
  // An audience may appear under multiple offerings
  interface AudienceGroup {
    audienceName: string;
    audienceId: string;
    offerings: {
      offeringName: string;
      offeringId: string;
      draftId: string;
      isReady: boolean;
      currentStep: number;
      status: string;
      deliverables: { id: string; medium: string; customName: string; stage: string; updatedAt: string }[];
    }[];
  }

  const audienceMap = new Map<string, AudienceGroup>();

  for (const offering of hierarchy) {
    for (const aud of offering.audiences) {
      if (!audienceMap.has(aud.id)) {
        audienceMap.set(aud.id, {
          audienceName: aud.name,
          audienceId: aud.id,
          offerings: [],
        });
      }
      audienceMap.get(aud.id)!.offerings.push({
        offeringName: offering.name,
        offeringId: offering.id,
        draftId: aud.threeTier.id,
        isReady: aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5,
        currentStep: aud.threeTier.currentStep,
        status: aud.threeTier.status,
        deliverables: aud.deliverables,
      });
    }
  }

  const audienceGroups = Array.from(audienceMap.values());
  const hasAnyContent = audienceGroups.length > 0;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>5 Chapter Stories</h1>
          <p className="page-description">Pick an audience and offering, then create deliverables.</p>
        </div>
      </header>

      {!hasAnyContent && (
        <div className="empty-state empty-state-enhanced">
          <div className="empty-icon">📖</div>
          <h3>No audience-offering pairs yet</h3>
          <p>Create an audience and an offering, then build a Three Tier to connect them. Once a Three Tier is ready, you can generate stories here.</p>
          <button className="btn btn-primary" onClick={() => navigate('/three-tiers')} style={{ marginTop: 16 }}>Go to Three Tiers</button>
        </div>
      )}

      {audienceGroups.map(group => (
        <section key={group.audienceId} className="fcs-group" style={{ marginBottom: 32 }}>
          <h2 className="fcs-group-audience">{group.audienceName}</h2>

          {group.offerings.map(off => (
            <div key={off.draftId} style={{ marginBottom: 20, marginLeft: 4 }}>
              <h3 className="fcs-group-offering" style={{ marginBottom: 8 }}>{off.offeringName}</h3>

              {!off.isReady ? (
                <div className="fcs-hint" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span>Three Tier {off.status === 'in_progress' ? `in progress (Step ${off.currentStep})` : 'needs to be built first'}.</span>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} onClick={() => navigate(`/three-tier/${off.draftId}`)}>
                    {off.status === 'in_progress' ? 'Continue building' : 'Start building'}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} onClick={() => document.dispatchEvent(new CustomEvent('maria-toggle', { detail: { open: true, message: `I want to build a Three Tier for ${off.offeringName} targeting ${group.audienceName}. Can you help?` } }))}>
                    Ask Maria to help
                  </button>
                </div>
              ) : (
                <div className="tt-card-grid">
                  {(() => {
                    // Distinguish multiple deliverables of the same medium
                    // by updated date, not by "#N" — humans cannot tell a
                    // row of "newsletter article #1/#2/#3" apart. customName
                    // (if meaningful) always wins.
                    const mediumTotals = new Map<string, number>();
                    for (const d of off.deliverables) {
                      mediumTotals.set(d.medium, (mediumTotals.get(d.medium) || 0) + 1);
                    }
                    const shortDate = (iso?: string) => {
                      if (!iso) return '';
                      const dt = new Date(iso);
                      if (isNaN(dt.getTime())) return '';
                      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    };
                    return off.deliverables.map(del => {
                      const total = mediumTotals.get(del.medium) || 1;
                      const baseMedium = getMediumLabel(del.medium);
                      const fallbackName = total > 1
                        ? `${baseMedium} · ${shortDate(del.updatedAt) || 'draft'}`
                        : baseMedium;
                      const displayName = del.customName || fallbackName;
                      return (
                        <div
                          key={del.id}
                          className="tt-card"
                          onClick={() => navigate(`/five-chapter/${off.draftId}?story=${del.id}`)}
                        >
                          <div className="tt-card-name">{displayName}</div>
                          <div className="tt-card-progress">
                            <span className="tt-card-status">{getStageLabel(del.stage)}</span>
                            <InfoTooltip text={del.stage === 'personalized' ? 'Story personalized with your writing style.' : del.stage === 'polished' ? 'Story polished for tone and flow.' : del.stage === 'blended' ? 'Chapters blended into one flowing piece.' : del.stage === 'joined' ? 'Chapters combined but not yet blended.' : 'Individual chapters generated.'} />
                          </div>
                          <div className="tt-card-updated">{formatUpdatedAt(del.updatedAt)}</div>
                          <div className="tt-card-action" style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/five-chapter/${off.draftId}?story=${del.id}`)}>
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
                    onClick={() => navigate(`/five-chapter/${off.draftId}`)}
                  >
                    <span className="tt-card-new-icon">+</span>
                    <span className="tt-card-new-label">New Deliverable</span>
                  </div>
                </div>
              )}
            </div>
          ))}
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
