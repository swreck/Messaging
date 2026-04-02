import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { DifferentiatorList } from '../shared/DifferentiatorList';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import type { Offering } from '../types';

interface LinkedDraft {
  id: string;
  audienceName: string;
  currentStep: number;
  status: string;
}

export function OfferingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [offering, setOffering] = useState<Offering | null>(null);
  const [linkedDrafts, setLinkedDrafts] = useState<LinkedDraft[]>([]);
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [smeRole, setSmeRole] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => {
    if (id) setPageContext({ page: 'offerings', offeringId: id });
    registerRefresh(loadData);
  }, [id]);
  useEffect(() => { loadData(); }, [id]);

  async function loadData() {
    if (!offering) setLoading(true);
    try {
      const [offRes, hierRes] = await Promise.all([
        api.get<{ offerings: Offering[] }>('/offerings'),
        api.get<{ hierarchy: { id: string; audiences: { name: string; threeTier: { id: string; currentStep: number; status: string } }[] }[] }>('/drafts/hierarchy'),
      ]);
      const found = offRes.offerings.find(o => o.id === id);
      setOffering(found || null);

      const hierOffering = hierRes.hierarchy.find(h => h.id === id);
      if (hierOffering) {
        setLinkedDrafts(hierOffering.audiences.map(a => ({
          id: a.threeTier.id,
          audienceName: a.name,
          currentStep: a.threeTier.currentStep,
          status: a.threeTier.status,
        })));
      }
    } finally {
      setLoading(false);
    }
  }

  function openEdit() {
    if (!offering) return;
    setName(offering.name);
    setSmeRole(offering.smeRole);
    setDescription(offering.description);
    setShowModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !offering) return;
    setSaving(true);
    try {
      await api.put(`/offerings/${offering.id}`, { name, smeRole, description });
      setShowModal(false);
      loadData();
    } finally {
      setSaving(false);
    }
  }

  async function deleteOffering() {
    if (!offering) return;
    if (!confirm('Delete this offering and all its Three Tier drafts?')) return;
    await api.delete(`/offerings/${offering.id}`);
    navigate('/offerings');
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  if (!offering) return (
    <div className="page-container">
      <div className="empty-state">
        <p>Offering not found.</p>
        <button className="btn btn-secondary" onClick={() => navigate('/offerings')} style={{ marginTop: 16 }}>Back to Offerings</button>
      </div>
    </div>
  );

  return (
    <div className="page-container">
      <button className="btn btn-ghost btn-sm back-link" onClick={() => navigate('/offerings')}>
        &larr; Offerings
      </button>

      <header className="page-header">
        <div>
          <h1>{offering.name}</h1>
          {offering.description && <p className="page-description">{offering.description}</p>}
          {offering.smeRole && <p className="page-meta">SME: {offering.smeRole}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={openEdit}>Edit</button>
          <button className="btn btn-ghost btn-danger" onClick={deleteOffering}>Delete</button>
        </div>
      </header>

      {offering.elements.length === 0 && (
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
          Add capabilities here, or let Maria pull them out during an interview. She'll ask what makes this offering different and capture what you tell her. You can start, stop, and continue whenever you want.
        </p>
      )}

      <DifferentiatorList
        offeringId={offering.id}
        elements={offering.elements}
        onUpdate={loadData}
        allowAdd={true}
        allowRemove={true}
      />

      {linkedDrafts.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Three Tier Messages</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {linkedDrafts.map(d => (
              <div
                key={d.id}
                onClick={() => navigate(`/three-tier/${d.id}`)}
                style={{
                  padding: '10px 14px',
                  background: 'var(--bg-secondary, #f8f8fa)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 14,
                }}
              >
                <span style={{ color: 'var(--text-primary)' }}>{d.audienceName}</span>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {d.status === 'complete' || d.currentStep === 5 ? 'Complete' : `Step ${d.currentStep}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Edit Offering">
        <form onSubmit={save}>
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label>Your Role / SME Role</label>
            <input value={smeRole} onChange={e => setSmeRole(e.target.value)} placeholder="e.g. Product Manager" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Brief description of this offering" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
