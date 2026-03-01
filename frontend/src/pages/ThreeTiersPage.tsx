import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import type { Offering, DraftSummary } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  audiences: {
    id: string;
    name: string;
    threeTier: { id: string; status: string; currentStep: number };
  }[];
}

export function ThreeTiersPage() {
  const navigate = useNavigate();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [allAudiences, setAllAudiences] = useState<{ id: string; name: string }[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewModal, setShowNewModal] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedAudienceId, setSelectedAudienceId] = useState('');

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'three-tiers' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    if (hierarchy.length === 0) setLoading(true);
    try {
      const [hierRes, offRes] = await Promise.all([
        api.get<{ hierarchy: HierarchyOffering[]; audiences: { id: string; name: string }[] }>('/drafts/hierarchy'),
        api.get<{ offerings: Offering[] }>('/offerings'),
      ]);
      setHierarchy(hierRes.hierarchy);
      setAllAudiences(hierRes.audiences);
      setOfferings(offRes.offerings);
    } finally {
      setLoading(false);
    }
  }

  function getAvailableAudiences(offeringId: string): { id: string; name: string }[] {
    const offering = hierarchy.find(o => o.id === offeringId);
    const usedIds = new Set(offering?.audiences.map(a => a.id) || []);
    return allAudiences.filter(a => !usedIds.has(a.id));
  }

  function openNewModal(preselectedOfferingId?: string) {
    setSelectedOfferingId(preselectedOfferingId || '');
    setSelectedAudienceId('');
    setShowNewModal(true);
  }

  async function startDraft() {
    if (!selectedOfferingId || !selectedAudienceId) return;
    try {
      const { draft } = await api.post<{ draft: DraftSummary }>('/drafts', {
        offeringId: selectedOfferingId,
        audienceId: selectedAudienceId,
      });
      navigate(`/three-tier/${draft.id}`);
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        const offering = hierarchy.find(o => o.id === selectedOfferingId);
        const audience = offering?.audiences.find(a => a.id === selectedAudienceId);
        if (audience) navigate(`/three-tier/${audience.threeTier.id}`);
      } else {
        alert(err.message);
      }
    }
  }

  function renderProgressDots(step: number, status: string) {
    const isComplete = status === 'complete' || step === 5;
    return (
      <div className="progress-dots">
        {[1, 2, 3, 4, 5].map(i => {
          let cls = 'dot-empty';
          if (isComplete && i <= step) cls = 'dot-complete';
          else if (i < step) cls = 'dot-complete';
          else if (i === step) cls = 'dot-current';
          return <span key={i} className={`progress-dot-mini ${cls}`} />;
        })}
      </div>
    );
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  // All offerings, including those without drafts
  const offeringsWithDrafts = hierarchy;
  const offeringsWithout = offerings.filter(o => !hierarchy.some(h => h.id === o.id));

  if (offerings.length === 0) {
    return (
      <div className="page-container">
        <header className="page-header">
          <h1>Three Tier Messages</h1>
          <p className="page-description">Value hierarchies built from your offerings and audiences</p>
        </header>
        <div className="empty-state">
          <h2 style={{ marginBottom: 8 }}>No offerings yet</h2>
          <p>Create an offering first, then you can build Three Tier messages for your audiences.</p>
          <button className="btn btn-secondary" onClick={() => navigate('/offerings')} style={{ marginTop: 16 }}>Go to Offerings</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Three Tier Messages</h1>
          <p className="page-description">Value hierarchies built from your offerings and audiences</p>
        </div>
        <button className="btn btn-primary" onClick={() => openNewModal()}>New Three Tier</button>
      </header>

      {offeringsWithDrafts.map(offering => (
        <section key={offering.id} className="tt-offering-section">
          <h2 className="tt-offering-name">{offering.name}</h2>
          <div className="tt-card-grid">
            {offering.audiences.map(aud => {
              const isComplete = aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5;
              return (
                <div
                  key={aud.id}
                  className="tt-card"
                  onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}
                >
                  <div className="tt-card-name">{aud.name}</div>
                  <div className="tt-card-progress">
                    {renderProgressDots(aud.threeTier.currentStep, aud.threeTier.status)}
                    <span className="tt-card-status">
                      {isComplete ? 'Complete' : `Step ${aud.threeTier.currentStep}`}
                    </span>
                  </div>
                  <div className="tt-card-action">
                    <button className="btn btn-ghost btn-sm">
                      {isComplete ? 'Open' : 'Continue'}
                    </button>
                  </div>
                </div>
              );
            })}

            <div
              className="tt-card tt-card-new"
              onClick={() => openNewModal(offering.id)}
            >
              <span className="tt-card-new-icon">+</span>
              <span className="tt-card-new-label">New</span>
            </div>
          </div>
        </section>
      ))}

      {offeringsWithout.map(o => (
        <section key={o.id} className="tt-offering-section">
          <h2 className="tt-offering-name">{o.name}</h2>
          <div className="tt-card-grid">
            <div
              className="tt-card tt-card-new"
              onClick={() => openNewModal(o.id)}
            >
              <span className="tt-card-new-icon">+</span>
              <span className="tt-card-new-label">New</span>
            </div>
          </div>
        </section>
      ))}

      <Modal open={showNewModal} onClose={() => setShowNewModal(false)} title="Start a Three Tier Message">
        <div className="form-group">
          <label>Offering</label>
          <select value={selectedOfferingId} onChange={e => { setSelectedOfferingId(e.target.value); setSelectedAudienceId(''); }}>
            <option value="">Select an offering...</option>
            {offerings.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Audience</label>
          <select value={selectedAudienceId} onChange={e => setSelectedAudienceId(e.target.value)} disabled={!selectedOfferingId}>
            <option value="">Select an audience...</option>
            {selectedOfferingId && getAvailableAudiences(selectedOfferingId).map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {selectedOfferingId && getAvailableAudiences(selectedOfferingId).length === 0 && (
            <p className="form-hint" style={{ marginTop: 8 }}>All audiences already have a Three Tier for this offering.</p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setShowNewModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={startDraft} disabled={!selectedOfferingId || !selectedAudienceId}>
            Start Building
          </button>
        </div>
      </Modal>
    </div>
  );
}
