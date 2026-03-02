import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { MappingDiagram } from '../shared/MappingDiagram';
import { Spinner } from '../shared/Spinner';
import type { ThreeTierDraft, Mapping } from '../types';

export function MappingPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [error, setError] = useState('');
  const serverRef = useRef<Mapping[]>([]);

  useEffect(() => {
    if (!draftId) return;
    api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`)
      .then(res => {
        setDraft(res.draft);
        serverRef.current = res.draft.mappings;
      })
      .catch(err => setError(err.message));
  }, [draftId]);

  async function handleChange(newMappings: { priorityId: string; elementId: string }[]) {
    if (!draftId) return;
    const server = serverRef.current;

    const toDelete = server.filter(s =>
      !newMappings.some(n => n.priorityId === s.priorityId && n.elementId === s.elementId)
    );
    const toCreate = newMappings.filter(n =>
      !server.some(s => s.priorityId === n.priorityId && s.elementId === n.elementId)
    );

    const newServer = server.filter(s => !toDelete.some(d => d.id === s.id));

    for (const d of toDelete) {
      await api.delete(`/mappings/${draftId}/${d.id}`);
    }
    for (const c of toCreate) {
      const { mapping } = await api.post<{ mapping: Mapping }>(`/mappings/${draftId}`, {
        priorityId: c.priorityId,
        elementId: c.elementId,
      });
      newServer.push(mapping);
    }
    serverRef.current = newServer;
  }

  if (error) {
    return (
      <div className="mapping-page">
        <p style={{ color: 'var(--danger)', padding: 40 }}>{error}</p>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="mapping-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="mapping-page">
      <div className="mapping-page-header">
        <div>
          <h1>Priority → Capability Mapping</h1>
          <p>{draft.audience.name} × {draft.offering.name}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="mapping-page-hint" style={{ fontSize: 16, maxWidth: 400 }}>
            Drag from any priority or capability box to draw a connection. Select a line, then press Delete to remove it.
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => window.close()}>
            Done
          </button>
        </div>
      </div>
      <MappingDiagram
        priorities={draft.audience.priorities.map(p => ({ id: p.id, text: p.text, rank: p.rank }))}
        elements={draft.offering.elements.map(e => ({ id: e.id, text: e.text }))}
        mappings={draft.mappings.map(m => ({ priorityId: m.priorityId, elementId: m.elementId }))}
        audienceName={draft.audience.name}
        offeringName={draft.offering.name}
        onChange={handleChange}
      />
    </div>
  );
}
