import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { DifferentiatorList } from '../shared/DifferentiatorList';
import { Spinner } from '../shared/Spinner';
import type { Offering } from '../types';

export function OfferingsPage() {
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [showModal, setShowModal] = useState(false);
  const [editingOffering, setEditingOffering] = useState<Offering | null>(null);
  const [name, setName] = useState('');
  const [smeRole, setSmeRole] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

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

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openNew() {
    setEditingOffering(null);
    setName('');
    setSmeRole('');
    setDescription('');
    setShowModal(true);
  }

  function openEdit(o: Offering) {
    setEditingOffering(o);
    setName(o.name);
    setSmeRole(o.smeRole);
    setDescription(o.description);
    setShowModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (editingOffering) {
        await api.put(`/offerings/${editingOffering.id}`, { name, smeRole, description });
      } else {
        await api.post('/offerings', { name, smeRole, description });
      }
      setShowModal(false);
      loadData();
    } finally {
      setSaving(false);
    }
  }

  async function deleteOffering(id: string) {
    if (!confirm('Delete this offering and all its Three Tier drafts?')) return;
    await api.delete(`/offerings/${id}`);
    loadData();
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Offerings</h1>
        <button className="btn btn-primary" onClick={openNew}>Add Offering</button>
      </header>

      {offerings.length === 0 && (
        <div className="empty-state">
          <h2 style={{ marginBottom: 8 }}>No offerings yet</h2>
          <p>Create your first offering to start building messages.</p>
          <button className="btn btn-secondary" onClick={openNew} style={{ marginTop: 16 }}>Add an Offering</button>
        </div>
      )}

      <div className="offering-cards">
        {offerings.map(o => (
          <div key={o.id} className="expandable-card">
            <div className="expandable-card-header" onClick={() => toggleExpand(o.id)}>
              <span className="expand-icon">{expanded.has(o.id) ? '\u25BC' : '\u25B6'}</span>
              <div className="expandable-card-title">
                <strong>{o.name}</strong>
                <span className="badge">{o.elements.length} capabilit{o.elements.length === 1 ? 'y' : 'ies'}</span>
                {o.smeRole && <span className="badge badge-muted">{o.smeRole}</span>}
              </div>
              <div className="expandable-card-actions" onClick={e => e.stopPropagation()}>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(o)}>Edit</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteOffering(o.id)}>Delete</button>
              </div>
            </div>

            {expanded.has(o.id) && (
              <div className="expandable-card-body">
                <DifferentiatorList
                  offeringId={o.id}
                  elements={o.elements}
                  onUpdate={loadData}
                  allowAdd={true}
                  allowRemove={true}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editingOffering ? 'Edit Offering' : 'New Offering'}>
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
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : editingOffering ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
