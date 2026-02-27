import { useState } from 'react';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { Spinner } from '../../shared/Spinner';
import { InfoTooltip } from '../../shared/InfoTooltip';
import type { Mapping, MappingSuggestionsResponse } from '../../types';

export function Step5DrawLines({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [mappings, setMappings] = useState<Mapping[]>(draft.mappings);
  const [suggesting, setSuggesting] = useState(false);
  const [selectedPriority, setSelectedPriority] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [gaps, setGaps] = useState<string[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);

  const priorities = draft.audience.priorities;
  const elements = draft.offering.elements;

  const mappedElementIds = new Set(mappings.filter(m => m.status !== 'rejected').map(m => m.elementId));
  const mappedPriorityIds = new Set(mappings.filter(m => m.status !== 'rejected').map(m => m.priorityId));

  async function suggestMappings() {
    setSuggesting(true);
    try {
      const result = await api.post<MappingSuggestionsResponse>('/ai/suggest-mappings', { draftId: draft.id });
      setOrphans(result.orphanElements || []);
      setGaps(result.priorityGaps || []);
      setQuestions(result.clarifyingQuestions || []);

      // Save suggestions as bulk
      if (result.mappings.length > 0) {
        const { mappings: saved } = await api.post<{ mappings: Mapping[] }>(`/mappings/${draft.id}/bulk`, {
          mappings: result.mappings.map(m => ({
            priorityId: m.priorityId,
            elementId: m.elementId,
            confidence: m.confidence,
            status: 'suggested',
          })),
        });
        setMappings(prev => [...prev.filter(m => m.status !== 'suggested'), ...saved]);
      }
    } catch (err: any) {
      alert(`AI suggestion failed: ${err.message}`);
    } finally {
      setSuggesting(false);
    }
  }

  async function confirmMapping(mappingId: string) {
    const { mapping } = await api.patch<{ mapping: Mapping }>(`/mappings/${draft.id}/${mappingId}`, { status: 'confirmed' });
    setMappings(prev => prev.map(m => m.id === mappingId ? mapping : m));
  }

  async function rejectMapping(mappingId: string) {
    const { mapping } = await api.patch<{ mapping: Mapping }>(`/mappings/${draft.id}/${mappingId}`, { status: 'rejected' });
    setMappings(prev => prev.map(m => m.id === mappingId ? mapping : m));
  }

  async function addManualMapping(elementId: string) {
    if (!selectedPriority) return;
    const { mapping } = await api.post<{ mapping: Mapping }>(`/mappings/${draft.id}`, {
      priorityId: selectedPriority,
      elementId,
      confidence: 1.0,
      status: 'confirmed',
    });
    setMappings(prev => [...prev, mapping]);
    setSelectedPriority(null);
  }

  async function deleteMapping(mappingId: string) {
    await api.delete(`/mappings/${draft.id}/${mappingId}`);
    setMappings(prev => prev.filter(m => m.id !== mappingId));
  }

  const confirmedCount = mappings.filter(m => m.status === 'confirmed').length;

  return (
    <div className="step-panel" style={{ maxWidth: 1100 }}>
      <h2>
        Step 5: Draw Lines
        <InfoTooltip text="Map each priority to the capabilities that support it. Direction: priority pulls capability. Capabilities with no priority connection are orphans — they won't make it into the message." />
      </h2>
      <p className="step-description">
        Connect priorities to capabilities. Maria can suggest mappings, then you confirm, reject, or add your own. Orphan capabilities (no connection) won't appear in your message.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-primary" onClick={suggestMappings} disabled={suggesting}>
          {suggesting ? <><Spinner size={14} /> Analyzing...</> : 'Ask Maria to Suggest Mappings'}
        </button>
      </div>

      {questions.length > 0 && (
        <div className="audit-panel" style={{ marginBottom: 16 }}>
          <h3>Maria has questions:</h3>
          {questions.map((q, i) => <p key={i} style={{ marginTop: 8 }}>{q}</p>)}
        </div>
      )}

      <div className="mapping-canvas">
        {/* Priorities column */}
        <div className="mapping-column">
          <h3>Priorities</h3>
          {priorities.map(p => (
            <div
              key={p.id}
              className={`mapping-item${selectedPriority === p.id ? ' selected' : ''}${mappedPriorityIds.has(p.id) ? ' mapped' : ''}`}
              onClick={() => setSelectedPriority(selectedPriority === p.id ? null : p.id)}
            >
              <strong>#{p.rank}</strong> {p.text}
              {gaps.includes(p.id) && <div style={{ color: 'var(--warning)', fontSize: 12, marginTop: 4 }}>No matching capability</div>}
            </div>
          ))}
        </div>

        {/* Connections */}
        <div className="mapping-line-area">
          <h3 style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Connections ({confirmedCount})</h3>
          {mappings.filter(m => m.status !== 'rejected').map(m => (
            <div key={m.id} className="mapping-connection">
              <div style={{ flex: 1, fontSize: 11 }}>
                #{m.priority.rank} → {m.element.text.substring(0, 20)}...
              </div>
              <span className={`mapping-confidence ${m.confidence >= 0.8 ? 'high' : m.confidence >= 0.6 ? 'medium' : 'low'}`}>
                {Math.round(m.confidence * 100)}%
              </span>
              {m.status === 'suggested' ? (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={() => confirmMapping(m.id)} title="Confirm" style={{ padding: '2px 6px', color: 'var(--success)' }}>✓</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => rejectMapping(m.id)} title="Reject" style={{ padding: '2px 6px', color: 'var(--danger)' }}>✗</button>
                </>
              ) : (
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => deleteMapping(m.id)} title="Remove" style={{ padding: '2px 6px' }}>&times;</button>
              )}
            </div>
          ))}
          {selectedPriority && <div style={{ fontSize: 12, color: 'var(--accent)', textAlign: 'center' }}>Click a capability to connect it</div>}
        </div>

        {/* Elements column */}
        <div className="mapping-column">
          <h3>Capabilities</h3>
          {elements.map(e => (
            <div
              key={e.id}
              className={`mapping-item${mappedElementIds.has(e.id) ? ' mapped' : ''}${orphans.includes(e.id) ? ' orphan' : ''}`}
              onClick={() => selectedPriority && addManualMapping(e.id)}
            >
              {e.text}
              {orphans.includes(e.id) && <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 4 }}>Orphan — won't be in message</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={() => { loadDraft(); nextStep(); }} disabled={confirmedCount < 1}>
          Next: Convert to Statements ({confirmedCount} connections)
        </button>
      </div>
    </div>
  );
}
