import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../shared/Modal';
import { ConfirmModal } from '../shared/ConfirmModal';
import { PriorityList } from '../shared/PriorityList';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { useToast } from '../shared/ToastContext';
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
  const { showToast } = useToast();
  const [audiences, setAudiences] = useState<AudienceWithRefs[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [showModal, setShowModal] = useState(false);
  const [editingAudience, setEditingAudience] = useState<Audience | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{id: string, name: string, draftCount: number} | null>(null);
  const [copyDropdownId, setCopyDropdownId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const copyDropdownRef = useRef<HTMLDivElement>(null);

  const { workspaces, activeWorkspace } = useWorkspace();
  const otherWorkspaces = activeWorkspace
    ? workspaces.filter(w => w.id !== activeWorkspace.id)
    : [];
  const hasMultipleWorkspaces = otherWorkspaces.length > 0;

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'audiences' }); registerRefresh(loadData); }, []);
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    // Only show full-page spinner on initial load — refreshes happen silently
    if (audiences.length === 0) setLoading(true);
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
      if (next.has(id)) {
        next.delete(id);
        setPageContext({ page: 'audiences' });
      } else {
        next.add(id);
        setPageContext({ page: 'audiences', audienceId: id });
      }
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

  function requestDelete(a: AudienceWithRefs) {
    setDeleteTarget({ id: a.id, name: a.name, draftCount: a.drafts?.length || 0 });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await api.delete(`/audiences/${deleteTarget.id}`);
    loadData();
  }

  async function duplicateAudience(id: string) {
    try {
      await api.post(`/audiences/${id}/duplicate`, {});
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Failed to duplicate audience');
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

  async function copyAudienceTo(audienceId: string, targetWorkspaceId: string, targetName: string) {
    setCopyDropdownId(null);
    try {
      await api.post(`/workspaces/${targetWorkspaceId}/copy-audience`, {
        audienceId,
        sourceWorkspaceId: activeWorkspace?.id,
      });
      setCopyFeedback(`Copied to ${targetName}`);
      setTimeout(() => setCopyFeedback(null), 2500);
    } catch (err: any) {
      setCopyFeedback(`Failed: ${err.message}`);
      setTimeout(() => setCopyFeedback(null), 3000);
    }
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
        <div>
          <h1>Audiences</h1>
          <p className="page-description">The people you're building messaging for</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>Add Audience</button>
      </header>

      {audiences.length === 0 && (
        <div className="empty-state empty-state-enhanced">
          <div className="empty-icon">👥</div>
          <h3>Tell Maria about your audience</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>If it helps you get started, I think of an audience as the person you'd like to help understand that doing what you want them to do is truly in their best interest. You can start anywhere in describing them.</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={() => {
              const bubble = document.querySelector('.partner-bubble') as HTMLElement;
              if (bubble) bubble.click();
            }}>Work with Maria</button>
            <button className="btn btn-ghost btn-sm" onClick={openNew}>or add manually</button>
          </div>
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
                {a.drafts && a.drafts.length > 0 && (
                  <span className="badge" style={{ background: 'var(--accent-bg, #e8f0fe)', color: 'var(--accent, #007aff)' }}>
                    {a.drafts.length} draft{a.drafts.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="expandable-card-actions" onClick={e => e.stopPropagation()}>
                {hasMultipleWorkspaces && (
                  <div className="copy-to-wrapper" ref={copyDropdownId === a.id ? copyDropdownRef : undefined}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setCopyDropdownId(copyDropdownId === a.id ? null : a.id)}>Copy to...</button>
                    {copyDropdownId === a.id && (
                      <div className="copy-to-dropdown">
                        {otherWorkspaces.map(w => (
                          <button key={w.id} className="copy-to-option" onClick={() => copyAudienceTo(a.id, w.id, w.name)}>{w.name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => duplicateAudience(a.id)}>Duplicate</button>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(a)}>Edit</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => requestDelete(a)}>Delete</button>
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

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete Audience"
        message={`Delete "${deleteTarget?.name}" and all its priorities?`}
        detail={
          deleteTarget?.draftCount
            ? `This will also delete ${deleteTarget.draftCount} Three Tier message${deleteTarget.draftCount !== 1 ? 's' : ''} using this audience.`
            : 'Any Three Tier messages using this audience will also be deleted.'
        }
      />

      {copyFeedback && (
        <div className="copy-feedback-toast">{copyFeedback}</div>
      )}
    </div>
  );
}
