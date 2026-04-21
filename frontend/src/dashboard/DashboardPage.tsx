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
  const [consultation, setConsultation] = useState(() => {
    try {
      const saved = localStorage.getItem('maria-consultation');
      return saved === null ? true : saved === 'on';
    } catch { return true; }
  });

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

  // First Three Tier prompt — user has an offering and audience set up but no draft yet.
  // This closes the gap Ken hit: new users arrive on the dashboard and don't know where to start.
  const hasSetup = offerings.length > 0 && audiences.length > 0;
  const needsFirstThreeTier = hasSetup && allDrafts.length === 0;

  function getStepLabel(step: number): string {
    const labels = [
      'Setting up',
      'Describing your offering',
      'Defining your audience',
      'Mapping priorities',
      'Reviewing your message',
    ];
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

  function toggleConsultation() {
    const next = !consultation;
    setConsultation(next);
    try { localStorage.setItem('maria-consultation', next ? 'on' : 'off'); } catch {}
    if (next) navigate('/express');
  }

  return (
    <div className="dashboard">
      {/* Consultation toggle — default ON */}
      <div className="consultation-toggle-bar">
        <div className="consultation-toggle-left">
          {activeWorkspace && (
            <h2 className="dashboard-workspace-name" style={{ margin: 0 }}>{activeWorkspace.name}</h2>
          )}
        </div>
        <label className="consultation-toggle" title={consultation ? 'Maria guides you through building your message. Turn off to work manually.' : 'Turn on to let Maria guide you through building your message step by step.'}>
          <span className={`consultation-toggle-label ${consultation ? 'consultation-toggle-label-active' : ''}`}>
            {consultation ? 'Maria is your partner' : 'Add collaboration'}
          </span>
          <button
            type="button"
            className={`consultation-switch ${consultation ? 'consultation-switch-on' : ''}`}
            onClick={toggleConsultation}
            aria-label="Toggle Maria collaboration"
          >
            <span className="consultation-switch-thumb" />
          </button>
        </label>
      </div>

      {/* New user — go straight to guided */}
      {isNew && (
        <div className="dashboard-welcome empty-state-enhanced">
          <div className="empty-icon">💬</div>
          <h3>Welcome to Maria</h3>
          <p>Maria will help you build persuasive messaging through a guided conversation. Just answer her questions.</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/express')}
            style={{ marginTop: 12 }}
          >
            Get started with Maria
          </button>
        </div>
      )}

      {/* First Three Tier prompt — setup is done, but no draft exists yet */}
      {needsFirstThreeTier && (
        <div
          className="dashboard-continue"
          onClick={() => navigate('/three-tiers')}
          style={{
            padding: '20px 22px',
            marginBottom: 20,
            background: 'var(--accent-light, #eaf4ff)',
            borderRadius: 'var(--radius-md, 10px)',
            border: '1px solid var(--accent, #007aff)',
            cursor: 'pointer',
            transition: 'box-shadow 0.15s',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--accent, #007aff)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Start here
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            Build your first Three Tier message
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            You've got {offerings.length === 1 ? 'an offering' : `${offerings.length} offerings`} and {audiences.length === 1 ? 'an audience' : `${audiences.length} audiences`} set up. Tap here to pair one with another and let Maria draft the message.
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>
              Recent work
            </h3>
            <button
              className="btn btn-ghost"
              onClick={() => navigate('/express')}
              style={{ fontSize: 13, color: 'var(--accent, #007aff)', padding: '4px 10px' }}
            >
              + New message
            </button>
          </div>
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
                  {d.deliverableCount > 0 && (
                    <div
                      style={{ fontSize: 12, color: 'var(--accent, #007aff)', flexShrink: 0, marginLeft: 12, cursor: 'pointer' }}
                      onClick={e => { e.stopPropagation(); navigate(`/five-chapter/${d.draftId}`); }}
                    >
                      {d.deliverableCount} stor{d.deliverableCount === 1 ? 'y' : 'ies'} →
                    </div>
                  )}
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
