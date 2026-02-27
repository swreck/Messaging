import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { Spinner } from '../shared/Spinner';
import type { Offering, Audience, DraftSummary } from '../types';

export function DashboardPage() {
  const navigate = useNavigate();
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  const [showStartDraft, setShowStartDraft] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedAudienceId, setSelectedAudienceId] = useState('');

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [o, a, d] = await Promise.all([
        api.get<{ offerings: Offering[] }>('/offerings'),
        api.get<{ audiences: Audience[] }>('/audiences'),
        api.get<{ drafts: DraftSummary[] }>('/drafts'),
      ]);
      setOfferings(o.offerings);
      setAudiences(a.audiences);
      setDrafts(d.drafts);
    } finally {
      setLoading(false);
    }
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
    if (editingOffering) {
      await api.put(`/offerings/${editingOffering.id}`, { name: offeringName, smeRole: offeringSmeRole, description: offeringDesc });
    } else {
      await api.post('/offerings', { name: offeringName, smeRole: offeringSmeRole, description: offeringDesc });
    }
    setShowOfferingModal(false);
    loadAll();
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
    if (editingAudience) {
      await api.put(`/audiences/${editingAudience.id}`, { name: audienceName, description: audienceDesc });
    } else {
      await api.post('/audiences', { name: audienceName, description: audienceDesc });
    }
    setShowAudienceModal(false);
    loadAll();
  }

  async function deleteAudience(id: string) {
    if (!confirm('Delete this audience? Priorities will be lost.')) return;
    await api.delete(`/audiences/${id}`);
    loadAll();
  }

  // ─── Draft creation ─────────────────────────────────

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
        const existing = drafts.find(d => d.offeringId === selectedOfferingId && d.audienceId === selectedAudienceId);
        if (existing) navigate(`/three-tier/${existing.id}`);
      } else {
        alert(err.message);
      }
    }
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Your Messages</h1>
        <button className="btn btn-primary" onClick={() => setShowStartDraft(true)}>
          New Three Tier
        </button>
      </header>

      {/* Active Drafts */}
      {drafts.length > 0 && (
        <section className="dashboard-section">
          <h2>In Progress</h2>
          <div className="card-grid">
            {drafts.map(d => (
              <div key={d.id} className="draft-card" onClick={() => navigate(`/three-tier/${d.id}`)}>
                <div className="draft-card-title">{d.offering.name}</div>
                <div className="draft-card-audience">for {d.audience.name}</div>
                <div className="draft-card-step">Step {d.currentStep} of 8</div>
                <div className="draft-card-progress">
                  <div className="progress-bar-mini" style={{ width: `${(d.currentStep / 8) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Offerings */}
      <section className="dashboard-section">
        <div className="section-header">
          <h2>Offerings</h2>
          <button className="btn btn-secondary btn-sm" onClick={openNewOffering}>Add Offering</button>
        </div>
        {offerings.length === 0 ? (
          <p className="empty-state">No offerings yet. Add one to get started.</p>
        ) : (
          <div className="card-grid">
            {offerings.map(o => (
              <div key={o.id} className="entity-card">
                <div className="entity-card-header">
                  <h3>{o.name}</h3>
                  <div className="entity-card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditOffering(o)}>Edit</button>
                    <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteOffering(o.id)}>Delete</button>
                  </div>
                </div>
                {o.smeRole && <div className="entity-card-meta">SME: {o.smeRole}</div>}
                {o.description && <p className="entity-card-desc">{o.description}</p>}
                {o.elements.length > 0 && (
                  <div className="entity-card-count">{o.elements.length} capability{o.elements.length !== 1 ? 'ies' : 'y'}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Audiences */}
      <section className="dashboard-section">
        <div className="section-header">
          <h2>Audiences</h2>
          <button className="btn btn-secondary btn-sm" onClick={openNewAudience}>Add Audience</button>
        </div>
        {audiences.length === 0 ? (
          <p className="empty-state">No audiences yet. Add one to get started.</p>
        ) : (
          <div className="card-grid">
            {audiences.map(a => (
              <div key={a.id} className="entity-card">
                <div className="entity-card-header">
                  <h3>{a.name}</h3>
                  <div className="entity-card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditAudience(a)}>Edit</button>
                    <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteAudience(a.id)}>Delete</button>
                  </div>
                </div>
                {a.description && <p className="entity-card-desc">{a.description}</p>}
                {a.priorities.length > 0 && (
                  <div className="entity-card-count">{a.priorities.length} priorit{a.priorities.length !== 1 ? 'ies' : 'y'}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

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
            <button type="submit" className="btn btn-primary">{editingOffering ? 'Save' : 'Create'}</button>
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
            <button type="submit" className="btn btn-primary">{editingAudience ? 'Save' : 'Create'}</button>
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
