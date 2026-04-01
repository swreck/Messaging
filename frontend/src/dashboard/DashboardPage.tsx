import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { InfoTooltip } from '../shared/InfoTooltip';
import type { Offering, Audience } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  elementCount: number;
  audiences: {
    id: string;
    name: string;
    threeTier: { id: string; status: string; currentStep: number };
    deliverables: { id: string; medium: string; stage: string; updatedAt: string }[];
  }[];
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

  // Compute tile counts
  function getAudienceStats() {
    const count = audiences.length;
    const totalPriorities = audiences.reduce((sum, a) => sum + a.priorities.length, 0);
    return { count, totalPriorities };
  }

  function getOfferingStats() {
    const count = offerings.length;
    const totalCapabilities = offerings.reduce((sum, o) => sum + o.elements.length, 0);
    return { count, totalCapabilities };
  }

  function getThreeTierStats() {
    let active = 0;
    let complete = 0;
    for (const offering of hierarchy) {
      for (const aud of offering.audiences) {
        if (aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5) {
          complete++;
        } else {
          active++;
        }
      }
    }
    return { active, complete };
  }

  function getFiveChapterCount() {
    let count = 0;
    for (const offering of hierarchy) {
      for (const aud of offering.audiences) {
        count += aud.deliverables.length;
      }
    }
    return count;
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  const audStats = getAudienceStats();
  const offStats = getOfferingStats();
  const ttStats = getThreeTierStats();
  const fcsCount = getFiveChapterCount();
  const isNew = offerings.length === 0 && audiences.length === 0;

  return (
    <div className="dashboard">
      {/* Workspace header */}
      {activeWorkspace && (
        <h2 className="dashboard-workspace-name">{activeWorkspace.name}</h2>
      )}

      {/* Empty state for new users */}
      {isNew && (
        <div className="dashboard-welcome empty-state-enhanced">
          <div className="empty-icon">💬</div>
          <h3>Welcome to Maria</h3>
          <p>Your message coaching workspace. Start by creating an audience and an offering, then build your first Three Tier message.</p>
          <div className="dashboard-welcome-actions">
            <button className="btn btn-primary" onClick={() => navigate('/audiences')}>Create an Audience</button>
            <button className="btn btn-secondary" onClick={() => navigate('/offerings')}>Create an Offering</button>
          </div>
        </div>
      )}

      {/* Navigation tiles */}
      {!isNew && (
        <div className="nav-tiles">
          <div className="nav-tile nav-tile-audiences" onClick={() => navigate('/audiences')}>
            <div className="nav-tile-icon">👥</div>
            <div className="nav-tile-title">Audiences <InfoTooltip text="The groups of people you want to persuade. Each has priorities they care about when evaluating what you offer." /></div>
            <div className="nav-tile-stat">
              {audStats.count > 0
                ? `${audStats.count} audience${audStats.count !== 1 ? 's' : ''}${audStats.totalPriorities > 0 ? ` · ${audStats.totalPriorities} priorities` : ''}`
                : 'Define who you\u2019re talking to'}
            </div>
          </div>

          <div className="nav-tile nav-tile-offerings" onClick={() => navigate('/offerings')}>
            <div className="nav-tile-icon">✨</div>
            <div className="nav-tile-title">Offerings <InfoTooltip text="Your products and services. Each has capabilities that make it valuable to your audiences." /></div>
            <div className="nav-tile-stat">
              {offStats.count > 0
                ? `${offStats.count} offering${offStats.count !== 1 ? 's' : ''}${offStats.totalCapabilities > 0 ? ` · ${offStats.totalCapabilities} capabilities` : ''}`
                : 'Add your products and services'}
            </div>
          </div>

          <div className="nav-tile nav-tile-three-tiers" onClick={() => navigate('/three-tiers')}>
            <div className="nav-tile-icon">💬</div>
            <div className="nav-tile-title">Three Tier Messages <InfoTooltip text="Connects what your audience cares about to what you offer — from the core value down to proof points." /></div>
            <div className="nav-tile-stat">
              {ttStats.active > 0 || ttStats.complete > 0
                ? <>
                    {ttStats.active > 0 && `${ttStats.active} active`}
                    {ttStats.active > 0 && ttStats.complete > 0 && ' · '}
                    {ttStats.complete > 0 && `${ttStats.complete} complete`}
                  </>
                : 'Build your first value hierarchy'}
            </div>
          </div>

          <div className="nav-tile nav-tile-five-chapters" onClick={() => navigate('/five-chapters')}>
            <div className="nav-tile-icon">📖</div>
            <div className="nav-tile-title">Five Chapter Stories <InfoTooltip text="Narrative stories generated from completed three-tier messages, formatted for email, presentations, and more." /></div>
            <div className="nav-tile-stat">
              {fcsCount > 0
                ? `${fcsCount} deliverable${fcsCount !== 1 ? 's' : ''}`
                : 'Generate stories from completed tiers'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
