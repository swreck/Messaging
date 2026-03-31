import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
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

interface ContinueItem {
  draftId: string;
  offeringName: string;
  audienceName: string;
  currentStep: number;
  status: string;
  updatedAt: string;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);
  const [workflowDismissed, setWorkflowDismissed] = useState(() => localStorage.getItem('maria-workflow-dismissed') === 'true');

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

  // Find the most recently edited in-progress draft
  function getContinueItem(): ContinueItem | null {
    let best: ContinueItem | null = null;

    for (const offering of hierarchy) {
      for (const aud of offering.audiences) {
        if (aud.threeTier.status === 'complete' && aud.threeTier.currentStep === 5) continue;
        // Use deliverables updatedAt or fallback — we need to check draft updatedAt
        // Since hierarchy doesn't include draft updatedAt, we'll use a heuristic:
        // the first in-progress item found (hierarchy is already sorted by updatedAt desc)
        if (!best) {
          best = {
            draftId: aud.threeTier.id,
            offeringName: offering.name,
            audienceName: aud.name,
            currentStep: aud.threeTier.currentStep,
            status: aud.threeTier.status,
            updatedAt: '',
          };
        }
      }
    }
    return best;
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

  function getStepLabel(step: number): string {
    const labels = ['Confirm', 'Your Offering', 'Your Audience', 'Building', 'Your Three Tier'];
    return labels[step - 1] || `Step ${step}`;
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  const continueItem = getContinueItem();
  const audStats = getAudienceStats();
  const offStats = getOfferingStats();
  const ttStats = getThreeTierStats();
  const fcsCount = getFiveChapterCount();
  const isNew = offerings.length === 0 && audiences.length === 0;

  return (
    <div className="dashboard">
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

      {/* Continue Working card */}
      {!isNew && continueItem && (
        <div className="continue-card" onClick={() => navigate(`/three-tier/${continueItem.draftId}`)}>
          <div className="continue-card-label">Continue Working</div>
          <div className="continue-card-title">
            {continueItem.offeringName} &times; {continueItem.audienceName}
          </div>
          <div className="continue-card-progress">
            <div className="progress-dots">
              {[1, 2, 3, 4, 5].map(i => (
                <span
                  key={i}
                  className={`progress-dot-mini ${i <= continueItem.currentStep ? 'dot-filled' : 'dot-empty'}`}
                />
              ))}
            </div>
            <span className="continue-card-step">{getStepLabel(continueItem.currentStep)}</span>
          </div>
          <button className="btn btn-primary btn-sm continue-card-btn">Continue</button>
        </div>
      )}

      {/* Workflow guide */}
      {!isNew && !workflowDismissed && (
        <div className="workflow-guide">
          <button className="workflow-dismiss" onClick={() => { setWorkflowDismissed(true); localStorage.setItem('maria-workflow-dismissed', 'true'); }} aria-label="Dismiss">&times;</button>
          <div className="workflow-steps">
            <div className={`workflow-step ${audStats.count > 0 ? 'step-done' : 'step-current'}`}>
              <div className="workflow-step-num">1</div>
              <div className="workflow-step-label">Audiences</div>
              <div className="workflow-step-hint">{audStats.count > 0 ? `${audStats.count} defined` : 'Who are you talking to?'}</div>
            </div>
            <div className="workflow-arrow">&rarr;</div>
            <div className={`workflow-step ${offStats.count > 0 ? 'step-done' : audStats.count > 0 ? 'step-current' : 'step-future'}`}>
              <div className="workflow-step-num">2</div>
              <div className="workflow-step-label">Offerings</div>
              <div className="workflow-step-hint">{offStats.count > 0 ? `${offStats.count} defined` : 'What do you offer?'}</div>
            </div>
            <div className="workflow-arrow">&rarr;</div>
            <div className={`workflow-step ${ttStats.complete > 0 ? 'step-done' : ttStats.active > 0 ? 'step-current' : 'step-future'}`}>
              <div className="workflow-step-num">3</div>
              <div className="workflow-step-label">Three Tier</div>
              <div className="workflow-step-hint">{ttStats.complete > 0 ? `${ttStats.complete} complete` : ttStats.active > 0 ? `${ttStats.active} in progress` : 'Build your value hierarchy'}</div>
            </div>
            <div className="workflow-arrow">&rarr;</div>
            <div className={`workflow-step ${fcsCount > 0 ? 'step-done' : ttStats.complete > 0 ? 'step-current' : 'step-future'}`}>
              <div className="workflow-step-num">4</div>
              <div className="workflow-step-label">Five Chapter</div>
              <div className="workflow-step-hint">{fcsCount > 0 ? `${fcsCount} stories` : 'Generate stories'}</div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation tiles */}
      {!isNew && (
        <div className="nav-tiles">
          <div className="nav-tile nav-tile-audiences" onClick={() => navigate('/audiences')}>
            <div className="nav-tile-icon">👥</div>
            <div className="nav-tile-title">Audiences</div>
            <div className="nav-tile-stat">
              {audStats.count > 0
                ? `${audStats.count} audience${audStats.count !== 1 ? 's' : ''}${audStats.totalPriorities > 0 ? ` · ${audStats.totalPriorities} priorities` : ''}`
                : 'Define who you\u2019re talking to'}
            </div>
          </div>

          <div className="nav-tile nav-tile-offerings" onClick={() => navigate('/offerings')}>
            <div className="nav-tile-icon">✨</div>
            <div className="nav-tile-title">Offerings</div>
            <div className="nav-tile-stat">
              {offStats.count > 0
                ? `${offStats.count} offering${offStats.count !== 1 ? 's' : ''}${offStats.totalCapabilities > 0 ? ` · ${offStats.totalCapabilities} capabilities` : ''}`
                : 'Add your products and services'}
            </div>
          </div>

          <div className="nav-tile nav-tile-three-tiers" onClick={() => navigate('/three-tiers')}>
            <div className="nav-tile-icon">💬</div>
            <div className="nav-tile-title">Three Tier Messages</div>
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
            <div className="nav-tile-title">Five Chapter Stories</div>
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
