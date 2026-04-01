import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import type { Offering, Audience } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  elementCount: number;
  audiences: {
    id: string;
    name: string;
    threeTier: {
      id: string;
      status: string;
      currentStep: number;
      updatedAt: string;
      tier1Text: string | null;
    };
    deliverables: { id: string; medium: string; stage: string; updatedAt: string }[];
  }[];
}

interface ActiveDraft {
  draftId: string;
  offeringName: string;
  audienceName: string;
  currentStep: number;
  status: string;
  tier1Text: string | null;
  updatedAt: string;
  deliverableCount: number;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'dashboard' }); registerRefresh(loadAll); }, []);
  useEffect(() => { loadAll(); }, []);

  async function loadAll(retries = 2) {
    setLoading(true);
    try {
      const [h, o, a] = await Promise.all([
        api.get<{ hierarchy: HierarchyOffering[] }>('/drafts/hierarchy'),
        api.get<{ offerings: Offering[] }>('/offerings'),
        api.get<{ audiences: Audience[] }>('/audiences'),
      ]);
      setHierarchy(h.hierarchy);
      setOfferings(o.offerings);
      setAudiences(a.audiences);
    } catch {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 1500));
        return loadAll(retries - 1);
      }
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  const isNew = offerings.length === 0 && audiences.length === 0;

  // Flatten hierarchy into a list of all drafts, sorted by most recent
  const allDrafts: ActiveDraft[] = [];
  for (const offering of hierarchy) {
    for (const aud of offering.audiences) {
      allDrafts.push({
        draftId: aud.threeTier.id,
        offeringName: offering.name,
        audienceName: aud.name,
        currentStep: aud.threeTier.currentStep,
        status: aud.threeTier.status,
        tier1Text: aud.threeTier.tier1Text,
        updatedAt: aud.threeTier.updatedAt,
        deliverableCount: aud.deliverables.length,
      });
    }
  }
  allDrafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const inProgress = allDrafts.filter(d => d.status !== 'complete' && d.currentStep < 5);
  const completed = allDrafts.filter(d => d.status === 'complete' || d.currentStep === 5);
  const mostRecent = inProgress[0] || null;

  function getStepLabel(step: number): string {
    const labels = ['Confirm', 'Your Offering', 'Your Audience', 'Building', 'Your Three Tier'];
    return labels[step - 1] || `Step ${step}`;
  }

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return 'just now';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
  }

  // Counts for nav tiles
  const audCount = audiences.length;
  const offCount = offerings.length;
  const ttCount = allDrafts.length;
  const fcsCount = allDrafts.reduce((sum, d) => sum + d.deliverableCount, 0);

  return (
    <div className="dashboard">
      {activeWorkspace && (
        <h2 className="dashboard-workspace-name">{activeWorkspace.name}</h2>
      )}

      {/* New user welcome */}
      {isNew && (
        <div className="dashboard-welcome empty-state-enhanced">
          <div className="empty-icon">💬</div>
          <h3>Welcome to Maria</h3>
          <p>Start by creating an audience and an offering, then build your first Three Tier message.</p>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 8 }}>
            Or open Maria (bottom right) and tell her what you're working on — she'll set everything up.
          </p>
          <div className="dashboard-welcome-actions">
            <button className="btn btn-primary" onClick={() => navigate('/audiences')}>Create an Audience</button>
            <button className="btn btn-secondary" onClick={() => navigate('/offerings')}>Create an Offering</button>
          </div>
        </div>
      )}

      {/* Continue where you left off — only if there's an active draft */}
      {!isNew && mostRecent && (
        <div
          className="dashboard-continue"
          onClick={() => navigate(`/three-tier/${mostRecent.draftId}`)}
          style={{
            padding: '16px 20px',
            marginBottom: 20,
            background: 'var(--bg-secondary, #f8f8fa)',
            borderRadius: 'var(--radius-md, 10px)',
            border: '1px solid var(--border-light, #e5e5ea)',
            cursor: 'pointer',
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent, #007aff)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-light, #e5e5ea)')}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Pick up where you left off
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            {mostRecent.offeringName} → {mostRecent.audienceName}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {getStepLabel(mostRecent.currentStep)} · {formatTimeAgo(mostRecent.updatedAt)}
          </div>
        </div>
      )}

      {/* Nav tiles — compact when there's real content to show */}
      {!isNew && (
        <div className="nav-tiles">
          <div className="nav-tile nav-tile-audiences" onClick={() => navigate('/audiences')}>
            <div className="nav-tile-icon">👥</div>
            <div className="nav-tile-title">Audiences</div>
            <div className="nav-tile-stat">
              {audCount > 0 ? `${audCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-offerings" onClick={() => navigate('/offerings')}>
            <div className="nav-tile-icon">✨</div>
            <div className="nav-tile-title">Offerings</div>
            <div className="nav-tile-stat">
              {offCount > 0 ? `${offCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-three-tiers" onClick={() => navigate('/three-tiers')}>
            <div className="nav-tile-icon">💬</div>
            <div className="nav-tile-title">3 Tiers</div>
            <div className="nav-tile-stat">
              {ttCount > 0 ? `${ttCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-five-chapters" onClick={() => navigate('/five-chapters')}>
            <div className="nav-tile-icon">📖</div>
            <div className="nav-tile-title">5 Ch. Stories</div>
            <div className="nav-tile-stat">
              {fcsCount > 0 ? `${fcsCount}` : 'None yet'}
            </div>
          </div>
        </div>
      )}

      {/* Completed Three Tiers — portfolio view with Tier 1 text */}
      {completed.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Your messaging
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {completed.map(d => (
              <div
                key={d.draftId}
                onClick={() => navigate(`/three-tier/${d.draftId}`)}
                style={{
                  padding: '14px 18px',
                  background: 'var(--bg-primary, #fff)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-light, #e5e5ea)',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent, #007aff)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-light, #e5e5ea)')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {d.offeringName} → {d.audienceName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 12 }}>
                    {d.deliverableCount > 0 ? `${d.deliverableCount} stor${d.deliverableCount === 1 ? 'y' : 'ies'}` : ''}
                  </div>
                </div>
                {d.tier1Text && (
                  <div style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    marginTop: 6,
                    fontStyle: 'italic',
                    lineHeight: 1.5,
                  }}>
                    "{d.tier1Text}"
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other in-progress drafts (beyond the most recent) */}
      {inProgress.length > 1 && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            In progress
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {inProgress.slice(1).map(d => (
              <div
                key={d.draftId}
                onClick={() => navigate(`/three-tier/${d.draftId}`)}
                style={{
                  padding: '12px 18px',
                  background: 'var(--bg-primary, #fff)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-light, #e5e5ea)',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent, #007aff)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-light, #e5e5ea)')}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {d.offeringName} → {d.audienceName}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {getStepLabel(d.currentStep)} · {formatTimeAgo(d.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
