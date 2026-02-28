import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import type { Offering } from '../types';

export function OfferingsPage() {
  const navigate = useNavigate();
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [smeRole, setSmeRole] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'offerings' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const { offerings } = await api.get<{ offerings: Offering[] }>('/offerings');
      setOfferings(offerings);
    } finally {
      setLoading(false);
    }
  }

  function openNew() {
    setName('');
    setSmeRole('');
    setDescription('');
    setShowModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const { offering } = await api.post<{ offering: Offering }>('/offerings', { name, smeRole, description });
      setShowModal(false);
      navigate(`/offerings/${offering.id}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Offerings</h1>
          <p className="page-description">Your products and services, and what makes them different</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>Add Offering</button>
      </header>

      {offerings.length === 0 ? (
        <div className="empty-state-card">
          <h2>No offerings yet</h2>
          <p>Create your first offering to start building messages.</p>
          <button className="btn btn-primary" onClick={openNew} style={{ marginTop: 16 }}>Add an Offering</button>
        </div>
      ) : (
        <div className="list-cards">
          {offerings.map(o => (
            <div key={o.id} className="list-card" onClick={() => navigate(`/offerings/${o.id}`)}>
              <div className="list-card-content">
                <strong className="list-card-title">{o.name}</strong>
                <span className="list-card-meta">
                  {o.elements.length} capabilit{o.elements.length === 1 ? 'y' : 'ies'}
                </span>
              </div>
              <span className="list-card-arrow">&rsaquo;</span>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Offering">
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
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
