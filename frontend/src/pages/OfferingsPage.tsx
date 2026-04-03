import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { ConfirmModal } from '../shared/ConfirmModal';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { useToast } from '../shared/ToastContext';
import type { Offering } from '../types';

export function OfferingsPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingOffering, setEditingOffering] = useState<Offering | null>(null);
  const [name, setName] = useState('');
  const [smeRole, setSmeRole] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{id: string, name: string} | null>(null);
  const [copyDropdownId, setCopyDropdownId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const copyDropdownRef = useRef<HTMLDivElement>(null);

  const { workspaces, activeWorkspace } = useWorkspace();
  const otherWorkspaces = activeWorkspace
    ? workspaces.filter(w => w.id !== activeWorkspace.id)
    : [];
  const hasMultipleWorkspaces = otherWorkspaces.length > 0;

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'offerings' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    if (offerings.length === 0) setLoading(true);
    try {
      const { offerings: data } = await api.get<{ offerings: Offering[] }>('/offerings');
      setOfferings(data);
    } finally {
      setLoading(false);
    }
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
        setShowModal(false);
        loadData();
      } else {
        const { offering } = await api.post<{ offering: Offering }>('/offerings', { name, smeRole, description });
        setShowModal(false);
        navigate(`/offerings/${offering.id}`);
      }
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(o: Offering) {
    setDeleteTarget({ id: o.id, name: o.name });
  }

  async function duplicateOffering(id: string) {
    try {
      await api.post(`/offerings/${id}/duplicate`, {});
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Failed to duplicate offering');
    }
  }

  // Close copy dropdown on click outside
  useEffect(() => {
    if (!copyDropdownId) return;
    function handleClick(e: MouseEvent | TouchEvent) {
      if (copyDropdownRef.current && !copyDropdownRef.current.contains(e.target as Node)) {
        setCopyDropdownId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [copyDropdownId]);

  async function copyOfferingTo(offeringId: string, targetWorkspaceId: string, targetName: string) {
    setCopyDropdownId(null);
    try {
      await api.post(`/workspaces/${targetWorkspaceId}/copy-offering`, {
        offeringId,
        sourceWorkspaceId: activeWorkspace?.id,
      });
      setCopyFeedback(`Copied to ${targetName}`);
      setTimeout(() => setCopyFeedback(null), 2500);
    } catch (err: any) {
      setCopyFeedback(`Failed: ${err.message}`);
      setTimeout(() => setCopyFeedback(null), 3000);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await api.delete(`/offerings/${deleteTarget.id}`);
    loadData();
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Offerings</h1>
          <p className="page-description">What you're building messaging for</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>Add Offering</button>
      </header>

      {offerings.length === 0 ? (
        <div className="empty-state-card empty-state-enhanced">
          <div className="empty-icon">✨</div>
          <h3>What are you building messaging for?</h3>
          <p>Add the product or service you want to message. When you're ready, Maria will interview you about what makes it different.</p>
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
              <div className="list-card-actions" onClick={e => e.stopPropagation()}>
                {hasMultipleWorkspaces && (
                  <div className="copy-to-wrapper" ref={copyDropdownId === o.id ? copyDropdownRef : undefined}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setCopyDropdownId(copyDropdownId === o.id ? null : o.id)}>Copy to...</button>
                    {copyDropdownId === o.id && (
                      <div className="copy-to-dropdown">
                        {otherWorkspaces.map(w => (
                          <button key={w.id} className="copy-to-option" onClick={() => copyOfferingTo(o.id, w.id, w.name)}>{w.name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => duplicateOffering(o.id)}>Duplicate</button>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(o)}>Edit</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => requestDelete(o)}>Delete</button>
              </div>
              <span className="list-card-arrow">&rsaquo;</span>
            </div>
          ))}
        </div>
      )}

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

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete Offering"
        message={`Delete "${deleteTarget?.name}" and all its data?`}
        detail="Any Three Tier messages and Five Chapter stories built from this offering will also be deleted."
      />

      {copyFeedback && (
        <div className="copy-feedback-toast">{copyFeedback}</div>
      )}
    </div>
  );
}
