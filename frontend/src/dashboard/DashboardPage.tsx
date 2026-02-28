import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { Spinner } from '../shared/Spinner';
import type { Offering, Audience, DraftSummary } from '../types';
import { MEDIUM_OPTIONS } from '../types';

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
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [, setAllAudiences] = useState<{ id: string; name: string }[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);

  // Expand state
  const [expandedOfferings, setExpandedOfferings] = useState<Set<string>>(new Set());

  // Modal state
  const [showOfferingModal, setShowOfferingModal] = useState(false);
  const [showAudienceModal, setShowAudienceModal] = useState(false);
  const [editingOffering, setEditingOffering] = useState<Offering | null>(null);
  const [editingAudience, setEditingAudience] = useState<Audience | null>(null);

  // Form state
  const [offeringName, setOfferingName] = useState('');
  const [offeringSmeRole, setOfferingSmeRole] = useState('');
  const [offeringDesc, setOfferingDesc] = useState('');
  const [audienceName, setAudienceName] = useState('');
  const [audienceDesc, setAudienceDesc] = useState('');

  const [savingOffering, setSavingOffering] = useState(false);
  const [savingAudience, setSavingAudience] = useState(false);

  const [showStartDraft, setShowStartDraft] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedAudienceId, setSelectedAudienceId] = useState('');

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [h, o, a] = await Promise.all([
        api.get<{ hierarchy: HierarchyOffering[]; audiences: { id: string; name: string }[] }>('/drafts/hierarchy'),
        api.get<{ offerings: Offering[] }>('/offerings'),
        api.get<{ audiences: Audience[] }>('/audiences'),
      ]);
      setHierarchy(h.hierarchy);
      setAllAudiences(h.audiences);
      setOfferings(o.offerings);
      setAudiences(a.audiences);

      // Auto-expand offerings that have work in progress
      const expanded = new Set<string>();
      h.hierarchy.forEach(o => {
        if (o.audiences.length > 0) expanded.add(o.id);
      });
      setExpandedOfferings(expanded);
    } finally {
      setLoading(false);
    }
  }

  function toggleOffering(id: string) {
    setExpandedOfferings(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ─── Offering CRUD ──────────────────────────────────

  function openNewOffering() {
    setEditingOffering(null);
    setOfferingName('');
    setOfferingSmeRole('');
    setOfferingDesc('');
    setShowOfferingModal(true);
  }

  function openEditOffering(o: Offering) {
    setEditingOffering(o);
    setOfferingName(o.name);
    setOfferingSmeRole(o.smeRole);
    setOfferingDesc(o.description);
    setShowOfferingModal(true);
  }

  async function saveOffering(e: React.FormEvent) {
    e.preventDefault();
    if (savingOffering) return;
    setSavingOffering(true);
    try {
      if (editingOffering) {
        await api.put(`/offerings/${editingOffering.id}`, { name: offeringName, smeRole: offeringSmeRole, description: offeringDesc });
      } else {
        await api.post('/offerings', { name: offeringName, smeRole: offeringSmeRole, description: offeringDesc });
      }
      setShowOfferingModal(false);
      loadAll();
    } finally {
      setSavingOffering(false);
    }
  }

  async function deleteOffering(id: string) {
    if (!confirm('Delete this offering and all its Three Tier drafts?')) return;
    await api.delete(`/offerings/${id}`);
    loadAll();
  }

  // ─── Audience CRUD ──────────────────────────────────

  function openNewAudience() {
    setEditingAudience(null);
    setAudienceName('');
    setAudienceDesc('');
    setShowAudienceModal(true);
  }

  function openEditAudience(a: Audience) {
    setEditingAudience(a);
    setAudienceName(a.name);
    setAudienceDesc(a.description);
    setShowAudienceModal(true);
  }

  async function saveAudience(e: React.FormEvent) {
    e.preventDefault();
    if (savingAudience) return;
    setSavingAudience(true);
    try {
      if (editingAudience) {
        await api.put(`/audiences/${editingAudience.id}`, { name: audienceName, description: audienceDesc });
      } else {
        await api.post('/audiences', { name: audienceName, description: audienceDesc });
      }
      setShowAudienceModal(false);
      loadAll();
    } finally {
      setSavingAudience(false);
    }
  }

  // ─── Draft creation ─────────────────────────────────

  function openStartDraft(preselectedOfferingId?: string) {
    setSelectedOfferingId(preselectedOfferingId || '');
    setSelectedAudienceId('');
    setShowStartDraft(true);
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
        // Find the existing draft and navigate to it
        const offering = hierarchy.find(o => o.id === selectedOfferingId);
        const audience = offering?.audiences.find(a => a.id === selectedAudienceId);
        if (audience) navigate(`/three-tier/${audience.threeTier.id}`);
      } else {
        alert(err.message);
      }
    }
  }

  function getStepLabel(step: number): string {
    const labels = ['Confirm', 'Your Offering', 'Your Audience', 'Building', 'Your Three Tier'];
    return labels[step - 1] || `Step ${step}`;
  }

  function getMediumLabel(medium: string): string {
    return MEDIUM_OPTIONS.find(m => m.id === medium)?.label || medium;
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Your Messages</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={openNewAudience}>Add Audience</button>
          <button className="btn btn-ghost btn-sm" onClick={openNewOffering}>Add Offering</button>
          <button className="btn btn-primary" onClick={() => openStartDraft()}>
            New Three Tier
          </button>
        </div>
      </header>

      {/* Empty state */}
      {hierarchy.length === 0 && offerings.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <h2 style={{ marginBottom: 8 }}>Welcome to Maria</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
            Start by creating an offering and an audience, then build your first Three Tier message.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={openNewOffering}>Add an Offering</button>
            <button className="btn btn-secondary" onClick={openNewAudience}>Add an Audience</button>
          </div>
        </div>
      )}

      {/* Hierarchy view */}
      {(hierarchy.length > 0 || offerings.length > 0) && (
        <div className="hierarchy-view">
          {/* Offerings with work */}
          {hierarchy.map(offering => (
            <div key={offering.id} className="hierarchy-offering">
              <div
                className="hierarchy-offering-header"
                onClick={() => toggleOffering(offering.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '14px 16px',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius)',
                  background: 'var(--bg-secondary)',
                  marginBottom: expandedOfferings.has(offering.id) ? 0 : 8,
                  borderBottomLeftRadius: expandedOfferings.has(offering.id) ? 0 : undefined,
                  borderBottomRightRadius: expandedOfferings.has(offering.id) ? 0 : undefined,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 16 }}>
                  {expandedOfferings.has(offering.id) ? '\u25BC' : '\u25B6'}
                </span>
                <div style={{ flex: 1 }}>
                  <strong style={{ fontSize: 16 }}>{offering.name}</strong>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 13, marginLeft: 8 }}>
                    {offering.elementCount} capabilities &middot; {offering.audiences.length} audience{offering.audiences.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                  <button className="btn btn-ghost btn-sm" onClick={() => {
                    const o = offerings.find(x => x.id === offering.id);
                    if (o) openEditOffering(o);
                  }}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => openStartDraft(offering.id)}>+ Audience</button>
                </div>
              </div>

              {expandedOfferings.has(offering.id) && (
                <div style={{
                  borderLeft: '2px solid var(--border-light)',
                  marginLeft: 24,
                  marginBottom: 8,
                  paddingLeft: 16,
                  paddingTop: 8,
                  paddingBottom: 4,
                }}>
                  {offering.audiences.map(aud => {
                    const isComplete = aud.threeTier.currentStep === 5;
                    return (
                      <div key={aud.id} className="hierarchy-audience" style={{
                        padding: '10px 14px',
                        borderRadius: 'var(--radius-sm)',
                        marginBottom: 6,
                        background: 'var(--bg)',
                        border: '1px solid var(--border-light)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: aud.deliverables.length > 0 ? 8 : 0 }}>
                          <div>
                            <span
                              style={{ fontWeight: 500, cursor: 'pointer' }}
                              onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}
                            >
                              {aud.name}
                            </span>
                            <span style={{
                              fontSize: 12,
                              marginLeft: 8,
                              padding: '2px 8px',
                              borderRadius: 10,
                              background: isComplete ? 'var(--success-bg, #e8f5e9)' : 'var(--warning-bg, #fff3e0)',
                              color: isComplete ? 'var(--success, #2e7d32)' : 'var(--warning, #e65100)',
                            }}>
                              {isComplete ? 'Complete' : getStepLabel(aud.threeTier.currentStep)}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: 12 }}
                              onClick={() => navigate(`/three-tier/${aud.threeTier.id}`)}
                            >
                              Open
                            </button>
                            {isComplete && (
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: 12 }}
                                onClick={() => navigate(`/five-chapter/${aud.threeTier.id}`)}
                              >
                                + Deliverable
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Deliverables */}
                        {aud.deliverables.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {aud.deliverables.map(del => (
                              <span
                                key={del.id}
                                onClick={() => navigate(`/five-chapter/${aud.threeTier.id}`)}
                                style={{
                                  fontSize: 12,
                                  padding: '3px 10px',
                                  borderRadius: 12,
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border-light)',
                                  cursor: 'pointer',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                {getMediumLabel(del.medium)} &middot; {del.stage}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {/* Offerings without any work yet */}
          {offerings.filter(o => !hierarchy.some(h => h.id === o.id)).map(o => (
            <div key={o.id} className="hierarchy-offering" style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 16px',
              borderRadius: 'var(--radius)',
              background: 'var(--bg-secondary)',
              marginBottom: 8,
            }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 16 }}>&mdash;</span>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: 16 }}>{o.name}</strong>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13, marginLeft: 8 }}>
                  {o.elements.length} capabilities &middot; No audiences yet
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => openEditOffering(o)}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => openStartDraft(o.id)}>+ Audience</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteOffering(o.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Standalone audiences (not tied to any offering) */}
      {audiences.length > 0 && (
        <section className="dashboard-section" style={{ marginTop: 24 }}>
          <div className="section-header">
            <h2 style={{ fontSize: 15, color: 'var(--text-secondary)' }}>Audiences</h2>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {audiences.map(a => (
              <span
                key={a.id}
                className="audience-chip"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 20,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-light)',
                  fontSize: 14,
                  cursor: 'pointer',
                }}
                onClick={() => openEditAudience(a)}
              >
                {a.name}
                {a.priorities.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {a.priorities.length}p
                  </span>
                )}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Offering Modal */}
      <Modal open={showOfferingModal} onClose={() => setShowOfferingModal(false)} title={editingOffering ? 'Edit Offering' : 'New Offering'}>
        <form onSubmit={saveOffering}>
          <div className="form-group">
            <label>Name</label>
            <input value={offeringName} onChange={e => setOfferingName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label>Your Role / SME Role</label>
            <input value={offeringSmeRole} onChange={e => setOfferingSmeRole(e.target.value)} placeholder="e.g. Product Manager" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea value={offeringDesc} onChange={e => setOfferingDesc(e.target.value)} rows={3} placeholder="Brief description of this offering" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowOfferingModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={savingOffering}>{savingOffering ? 'Saving...' : editingOffering ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </Modal>

      {/* Audience Modal */}
      <Modal open={showAudienceModal} onClose={() => setShowAudienceModal(false)} title={editingAudience ? 'Edit Audience' : 'New Audience'}>
        <form onSubmit={saveAudience}>
          <div className="form-group">
            <label>Name</label>
            <input value={audienceName} onChange={e => setAudienceName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea value={audienceDesc} onChange={e => setAudienceDesc(e.target.value)} rows={3} placeholder="Who are these people? What do they care about?" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowAudienceModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={savingAudience}>{savingAudience ? 'Saving...' : editingAudience ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </Modal>

      {/* Start Draft Modal */}
      <Modal open={showStartDraft} onClose={() => setShowStartDraft(false)} title="Start a Three Tier Message">
        <div className="form-group">
          <label>Offering</label>
          <select value={selectedOfferingId} onChange={e => setSelectedOfferingId(e.target.value)}>
            <option value="">Select an offering...</option>
            {offerings.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Audience</label>
          <select value={selectedAudienceId} onChange={e => setSelectedAudienceId(e.target.value)}>
            <option value="">Select an audience...</option>
            {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {offerings.length === 0 || audiences.length === 0 ? (
          <p className="form-hint">Create at least one offering and one audience first.</p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setShowStartDraft(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={startDraft} disabled={!selectedOfferingId || !selectedAudienceId}>
            Start Building
          </button>
        </div>
      </Modal>
    </div>
  );
}
