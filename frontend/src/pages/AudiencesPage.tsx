import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { PriorityList } from '../shared/PriorityList';
import { Spinner } from '../shared/Spinner';
import type { Audience } from '../types';

interface AudienceDraftRef {
  draftId: string;
  offeringName: string;
  currentStep: number;
  status: string;
}

interface AudienceWithRefs extends Audience {
  drafts?: AudienceDraftRef[];
}

export function AudiencesPage() {
  const navigate = useNavigate();
  const [audiences, setAudiences] = useState<AudienceWithRefs[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [showModal, setShowModal] = useState(false);
  const [editingAudience, setEditingAudience] = useState<Audience | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [audRes, hierRes] = await Promise.all([
        api.get<{ audiences: Audience[] }>('/audiences'),
        api.get<{ hierarchy: { id: string; name: string; audiences: { id: string; threeTier: { id: string; currentStep: number; status: string } }[] }[] }>('/drafts/hierarchy'),
      ]);

      // Build cross-reference map: audienceId → drafts
      const draftsByAudience = new Map<string, AudienceDraftRef[]>();
      for (const offering of hierRes.hierarchy) {
        for (const aud of offering.audiences) {
          const refs = draftsByAudience.get(aud.id) || [];
          refs.push({
            draftId: aud.threeTier.id,
            offeringName: offering.name,
            currentStep: aud.threeTier.currentStep,
            status: aud.threeTier.status,
          });
          draftsByAudience.set(aud.id, refs);
        }
      }

      const enriched: AudienceWithRefs[] = audRes.audiences.map(a => ({
        ...a,
        drafts: draftsByAudience.get(a.id) || [],
      }));
      setAudiences(enriched);
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
    setEditingAudience(null);
    setName('');
    setDescription('');
    setShowModal(true);
  }

  function openEdit(a: Audience) {
    setEditingAudience(a);
    setName(a.name);
    setDescription(a.description);
    setShowModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (editingAudience) {
        await api.put(`/audiences/${editingAudience.id}`, { name, description });
      } else {
        await api.post('/audiences', { name, description });
      }
      setShowModal(false);
      loadData();
    } finally {
      setSaving(false);
    }
  }

  async function deleteAudience(id: string) {
    if (!confirm('Delete this audience and all associated priorities?')) return;
    await api.delete(`/audiences/${id}`);
    loadData();
  }

  function getStatusLabel(step: number, status: string): string {
    if (status === 'complete') return 'Complete';
    const labels = ['Confirm', 'Your Offering', 'Your Audience', 'Building', 'Your Three Tier'];
    return labels[step - 1] || `Step ${step}`;
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Audiences</h1>
        <button className="btn btn-primary" onClick={openNew}>Add Audience</button>
      </header>

      {audiences.length === 0 && (
        <div className="empty-state">
          <h2 style={{ marginBottom: 8 }}>No audiences yet</h2>
          <p>Create your first audience to start defining their priorities.</p>
          <button className="btn btn-secondary" onClick={openNew} style={{ marginTop: 16 }}>Add an Audience</button>
        </div>
      )}

      <div className="audience-cards">
        {audiences.map(a => (
          <div key={a.id} className="expandable-card">
            <div className="expandable-card-header" onClick={() => toggleExpand(a.id)}>
              <span className="expand-icon">{expanded.has(a.id) ? '\u25BC' : '\u25B6'}</span>
              <div className="expandable-card-title">
                <strong>{a.name}</strong>
                <span className="badge">{a.priorities.length} priorit{a.priorities.length === 1 ? 'y' : 'ies'}</span>
              </div>
              <div className="expandable-card-actions" onClick={e => e.stopPropagation()}>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(a)}>Edit</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteAudience(a.id)}>Delete</button>
              </div>
            </div>

            {expanded.has(a.id) && (
              <div className="expandable-card-body">
                <PriorityList
                  audienceId={a.id}
                  audienceName={a.name}
                  priorities={a.priorities}
                  onUpdate={loadData}
                  showMotivatingFactor={true}
                  allowAdd={true}
                  allowRemove={true}
                />

                {a.drafts && a.drafts.length > 0 && (
                  <div className="cross-reference">
                    <span className="cross-reference-label">Used in:</span>
                    {a.drafts.map(d => (
                      <span
                        key={d.draftId}
                        className="cross-reference-link"
                        onClick={() => navigate(`/three-tier/${d.draftId}`)}
                      >
                        {d.offeringName} ({getStatusLabel(d.currentStep, d.status)})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editingAudience ? 'Edit Audience' : 'New Audience'}>
        <form onSubmit={save}>
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Who are these people? What do they care about?" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : editingAudience ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
