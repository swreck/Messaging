import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { ConfirmModal } from '../shared/ConfirmModal';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useToast } from '../shared/ToastContext';
import type { Offering, DraftSummary, ThreeTierDraft } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  audiences: {
    id: string;
    name: string;
    threeTier: { id: string; status: string; currentStep: number; archived?: boolean; tier1Text?: string | null };
  }[];
}

export function ThreeTiersPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [allAudiences, setAllAudiences] = useState<{ id: string; name: string }[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewModal, setShowNewModal] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedAudienceId, setSelectedAudienceId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedHierarchy, setArchivedHierarchy] = useState<HierarchyOffering[]>([]);

  // Archive confirmation
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);

  // Compare
  const [compareSelection, setCompareSelection] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [compareDrafts, setCompareDrafts] = useState<[ThreeTierDraft, ThreeTierDraft] | null>(null);
  const [loadingCompare, setLoadingCompare] = useState(false);

  // Inline create within the modal
  const [creatingOffering, setCreatingOffering] = useState(false);
  const [newOfferingName, setNewOfferingName] = useState('');
  const [creatingAudience, setCreatingAudience] = useState(false);
  const [newAudienceName, setNewAudienceName] = useState('');

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'three-tiers' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); loadArchivedData(); }, []);

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

  async function loadArchivedData() {
    try {
      const hierRes = await api.get<{ hierarchy: HierarchyOffering[] }>('/drafts/hierarchy?includeArchived=true');
      // Filter to only archived drafts
      const archived = hierRes.hierarchy
        .map(o => ({
          ...o,
          audiences: o.audiences.filter(a => a.threeTier.archived),
        }))
        .filter(o => o.audiences.length > 0);
      setArchivedHierarchy(archived);
    } catch {
      setArchivedHierarchy([]);
    }
  }

  async function duplicateDraft(draftId: string) {
    try {
      const result = await api.post<{ draft: { archived?: boolean } }>(`/drafts/${draftId}/duplicate`, {});
      loadData();
      if (result.draft?.archived) {
        setShowArchived(true);
        loadArchivedData();
        showToast('Duplicate created in the Archived section (an active draft already exists for this audience).', 'info');
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to duplicate draft');
    }
  }

  async function archiveDraft(draftId: string) {
    try {
      await api.put(`/drafts/${draftId}/archive`, {});
      loadData();
      loadArchivedData();
    } catch (err: any) {
      showToast(err.message || 'Failed to archive draft');
    }
  }

  async function unarchiveDraft(draftId: string) {
    try {
      await api.put(`/drafts/${draftId}/unarchive`, {});
      loadData();
      loadArchivedData();
    } catch (err: any) {
      showToast(err.message || 'Failed to unarchive draft');
    }
  }

  function toggleShowArchived() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) loadArchivedData();
  }

  function getAvailableAudiences(offeringId: string): { id: string; name: string }[] {
    const offering = hierarchy.find(o => o.id === offeringId);
    const usedIds = new Set(offering?.audiences.map(a => a.id) || []);
    return allAudiences.filter(a => !usedIds.has(a.id));
  }

  function toggleCompareSelect(draftId: string) {
    setCompareSelection(prev => {
      const next = new Set(prev);
      if (next.has(draftId)) {
        next.delete(draftId);
      } else if (next.size < 2) {
        next.add(draftId);
      }
      return next;
    });
  }

  async function openCompare() {
    const ids = Array.from(compareSelection);
    if (ids.length !== 2) return;
    setLoadingCompare(true);
    setShowCompare(true);
    try {
      const [d1, d2] = await Promise.all([
        api.get<{ draft: ThreeTierDraft }>(`/drafts/${ids[0]}`),
        api.get<{ draft: ThreeTierDraft }>(`/drafts/${ids[1]}`),
      ]);
      setCompareDrafts([d1.draft, d2.draft]);
    } catch {
      setShowCompare(false);
    } finally {
      setLoadingCompare(false);
    }
  }

  async function inlineCreateOffering() {
    if (!newOfferingName.trim()) return;
    try {
      const { offering } = await api.post<{ offering: Offering }>('/offerings', {
        name: newOfferingName.trim(),
        smeRole: '',
        description: '',
      });
      await loadData();
      setSelectedOfferingId(offering.id);
      setSelectedAudienceId('');
      setCreatingOffering(false);
      setNewOfferingName('');
    } catch (err: any) {
      showToast(err.message || 'Failed to create offering');
      setCreatingOffering(false);
      setNewOfferingName('');
    }
  }

  async function inlineCreateAudience() {
    if (!newAudienceName.trim()) return;
    try {
      const { audience } = await api.post<{ audience: { id: string; name: string } }>('/audiences', {
        name: newAudienceName.trim(),
        description: '',
      });
      await loadData();
      setSelectedAudienceId(audience.id);
      setCreatingAudience(false);
      setNewAudienceName('');
    } catch (err: any) {
      showToast(err.message || 'Failed to create audience');
      setCreatingAudience(false);
      setNewAudienceName('');
    }
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
        showToast(err.message);
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
          <h1>3 Tier Messages</h1>
          <p className="page-description">Your messaging frameworks</p>
        </header>
        <div className="empty-state empty-state-enhanced">
          <div className="empty-icon">💬</div>
          <h3>Ready to build your first message?</h3>
          <p>You'll need an offering and an audience first — then Maria will walk you through building a Three Tier message step by step.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => navigate('/offerings')}>Add an Offering</button>
            <button className="btn btn-secondary" onClick={() => navigate('/audiences')}>Add an Audience</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>3 Tier Messages</h1>
          <p className="page-description">Your messaging frameworks</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {compareSelection.size === 2 && (
            <button className="btn btn-secondary" onClick={openCompare}>Compare Selected</button>
          )}
          {compareSelection.size > 0 && compareSelection.size < 2 && (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)', alignSelf: 'center' }}>Select one more to compare</span>
          )}
          <button className="btn btn-primary" onClick={() => openNewModal()}>New Three Tier</button>
        </div>
      </header>

      {offeringsWithDrafts.map(offering => (
        <section key={offering.id} className="tt-offering-section">
          <div className="tt-card-grid">
            {offering.audiences.map(aud => {
              const isComplete = aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5;
              return (
                <div
                  key={aud.id}
                  className="tt-card"
                  onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isComplete && (
                      <input
                        type="checkbox"
                        checked={compareSelection.has(aud.threeTier.id)}
                        onChange={() => toggleCompareSelect(aud.threeTier.id)}
                        onClick={e => e.stopPropagation()}
                        title="Select for comparison"
                        style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    )}
                    <div>
                      <div className="tt-card-audience">{aud.name}</div>
                      <div className="tt-card-offering">{offering.name}</div>
                    </div>
                  </div>
                  {isComplete && aud.threeTier.tier1Text && (
                    <div className="tt-card-tier1" style={{
                      fontSize: 13,
                      color: 'var(--text-secondary)',
                      fontStyle: 'italic',
                      lineHeight: 1.5,
                      margin: '6px 0 4px',
                    }}>
                      "{aud.threeTier.tier1Text}"
                    </div>
                  )}
                  <div className="tt-card-progress">
                    {renderProgressDots(aud.threeTier.currentStep, aud.threeTier.status)}
                    <span className="tt-card-status">
                      {isComplete ? 'Complete' : `Step ${aud.threeTier.currentStep}`}
                    </span>
                  </div>
                  <div className="tt-card-action" onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}>
                      {isComplete ? 'Open' : 'Continue'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => duplicateDraft(aud.threeTier.id)}>Duplicate</button>
                    {isComplete && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmArchiveId(aud.threeTier.id)}>Archive</button>
                    )}
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

      {/* Archive toggle — only show when there are archived items */}
      {(showArchived || archivedHierarchy.length > 0) && (
        <div style={{ marginTop: 24 }}>
          <button className="btn btn-ghost btn-sm" onClick={toggleShowArchived}>
            {showArchived ? 'Hide archived' : `Show archived (${archivedHierarchy.reduce((n, o) => n + o.audiences.length, 0)})`}
          </button>
        </div>
      )}

      {showArchived && archivedHierarchy.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, color: 'var(--text-secondary)', marginBottom: 12 }}>Archived</h3>
          {archivedHierarchy.map(offering => (
            <section key={offering.id} className="tt-offering-section">
              <h2 className="tt-offering-name">{offering.name}</h2>
              <div className="tt-card-grid">
                {offering.audiences.map(aud => (
                  <div
                    key={aud.id}
                    className="tt-card"
                    style={{ opacity: 0.7 }}
                    onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}
                  >
                    <div className="tt-card-name">{aud.name}</div>
                    <div className="tt-card-progress">
                      {renderProgressDots(aud.threeTier.currentStep, aud.threeTier.status)}
                      <span className="tt-card-status">Archived</span>
                    </div>
                    <div className="tt-card-action" onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm" onClick={() => unarchiveDraft(aud.threeTier.id)}>Unarchive</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal open={showNewModal} onClose={() => setShowNewModal(false)} title="Start a Three Tier Message">
        <div className="form-group">
          <label>Offering</label>
          {!creatingOffering ? (
            <>
              <select value={selectedOfferingId} onChange={e => { setSelectedOfferingId(e.target.value); setSelectedAudienceId(''); }}>
                <option value="">Select an offering...</option>
                {offerings.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: 13 }}
                onClick={() => setCreatingOffering(true)}
              >
                + Create new offering
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={newOfferingName}
                onChange={e => setNewOfferingName(e.target.value)}
                placeholder="Offering name"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && newOfferingName.trim()) inlineCreateOffering();
                  if (e.key === 'Escape') { setCreatingOffering(false); setNewOfferingName(''); }
                }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={inlineCreateOffering} disabled={!newOfferingName.trim()}>Create</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setCreatingOffering(false); setNewOfferingName(''); }}>Cancel</button>
            </div>
          )}
        </div>
        <div className="form-group">
          <label>Audience</label>
          {!creatingAudience ? (
            <>
              <select value={selectedAudienceId} onChange={e => setSelectedAudienceId(e.target.value)} disabled={!selectedOfferingId}>
                <option value="">Select an audience...</option>
                {selectedOfferingId && getAvailableAudiences(selectedOfferingId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              {selectedOfferingId && getAvailableAudiences(selectedOfferingId).length === 0 && (
                <p className="form-hint" style={{ marginTop: 8 }}>All audiences already have a Three Tier for this offering.</p>
              )}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: 13 }}
                onClick={() => setCreatingAudience(true)}
              >
                + Create new audience
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={newAudienceName}
                onChange={e => setNewAudienceName(e.target.value)}
                placeholder="Audience name"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && newAudienceName.trim()) inlineCreateAudience();
                  if (e.key === 'Escape') { setCreatingAudience(false); setNewAudienceName(''); }
                }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={inlineCreateAudience} disabled={!newAudienceName.trim()}>Create</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setCreatingAudience(false); setNewAudienceName(''); }}>Cancel</button>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setShowNewModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={startDraft} disabled={!selectedOfferingId || !selectedAudienceId}>
            Start Building
          </button>
        </div>
      </Modal>

      <Modal
        open={showCompare}
        onClose={() => { setShowCompare(false); setCompareDrafts(null); }}
        title="Compare Three Tiers"
        className="modal-wide"
      >
        {loadingCompare && <div style={{ padding: 40, textAlign: 'center' }}><Spinner size={24} /></div>}
        {compareDrafts && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, fontSize: 14 }}>
            {compareDrafts.map((d, i) => (
              <div key={i}>
                <div style={{ fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
                  {d.offering.name} → {d.audience.name}
                </div>

                {d.tier1Statement && (
                  <div style={{
                    padding: '10px 14px',
                    background: 'var(--bg-secondary, #f8f8fa)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    marginBottom: 12,
                    fontStyle: 'italic',
                    lineHeight: 1.6,
                  }}>
                    {d.tier1Statement.text}
                  </div>
                )}

                {d.tier2Statements.map((t2, j) => (
                  <div key={j} style={{ marginBottom: 10 }}>
                    {t2.categoryLabel && (
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                        {t2.categoryLabel}
                      </div>
                    )}
                    <div style={{ lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                      {t2.text}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirmArchiveId}
        title="Archive this Three Tier?"
        message="You can find it later in the Archived section and unarchive it anytime."
        confirmLabel="Archive"
        onConfirm={() => { if (confirmArchiveId) archiveDraft(confirmArchiveId); setConfirmArchiveId(null); }}
        onClose={() => setConfirmArchiveId(null)}
      />
    </div>
  );
}
