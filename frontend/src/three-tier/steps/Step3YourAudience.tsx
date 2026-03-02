import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { PriorityList } from '../../shared/PriorityList';
import { Modal } from '../../shared/Modal';
import { MappingDiagram } from '../../shared/MappingDiagram';
import { api } from '../../api/client';

interface MappingPreview {
  mappings: { priorityText: string; rank: number; capabilities: string[]; confidence: number }[];
  gaps: string[];
  orphans: string[];
}

function buildMappingsFromPreview(
  preview: MappingPreview,
  draft: StepProps['draft'],
): { priorityId: string; elementId: string }[] {
  const result: { priorityId: string; elementId: string }[] = [];
  for (const m of preview.mappings) {
    const priority = draft.audience.priorities.find(p => p.text === m.priorityText || p.rank === m.rank);
    if (!priority) continue;
    for (const capText of m.capabilities) {
      const element = draft.offering.elements.find(e => e.text === capText);
      if (element) {
        result.push({ priorityId: priority.id, elementId: element.id });
      }
    }
  }
  return result;
}

export function Step3YourAudience({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const hasEnough = draft.audience.priorities.length >= 2;
  const [searchParams, setSearchParams] = useSearchParams();
  const urlMode = searchParams.get('mode');
  const mode = !hasEnough ? 'edit' : (urlMode === 'edit' ? 'edit' : 'confirm');
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  function switchToEdit() {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('mode', 'edit');
      return next;
    });
  }

  async function saveConfirmEdit(id: string) {
    const trimmed = editText.trim();
    const original = draft.audience.priorities.find(p => p.id === id);
    if (!trimmed || trimmed === original?.text) {
      setEditingId(null);
      return;
    }
    setEditingId(null);
    await api.put(`/audiences/${draft.audienceId}/priorities/${id}`, { text: trimmed });
    await loadDraft();
  }

  async function addPriority(text: string) {
    if (!text.trim()) return;
    if (draft.audience.priorities.find(p => p.text === text.trim())) return;

    await api.post(`/audiences/${draft.audienceId}/priorities`, {
      text: text.trim(),
      rank: draft.audience.priorities.length + 1,
    });
    await loadDraft();
  }

  async function loadPreview() {
    setLoadingPreview(true);
    try {
      const result = await api.post<MappingPreview>('/ai/preview-mapping', { draftId: draft.id });
      setPreview(result);
      setShowMappingModal(true);
    } finally {
      setLoadingPreview(false);
    }
  }

  if (mode === 'confirm') {
    return (
      <div className="step-panel">
        <div className="confirm-panel">
          <h2>{draft.audience.name}'s Priorities</h2>
          <ol className="confirm-list">
            {draft.audience.priorities.map(p => (
              <li key={p.id} className="confirm-list-item confirm-list-item-clickable">
                {editingId === p.id ? (
                  <input
                    className="priority-text-input"
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onBlur={() => saveConfirmEdit(p.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveConfirmEdit(p.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <span onClick={() => { setEditingId(p.id); setEditText(p.text); }}>{p.text}</span>
                )}
                {p.motivatingFactor && editingId !== p.id && (
                  <span className="confirm-list-mf">{p.motivatingFactor}</span>
                )}
              </li>
            ))}
          </ol>
          <p className="confirm-hint">Click any priority to edit</p>

          <div className="confirm-actions">
            <button className="btn btn-primary" onClick={nextStep}>Use this list</button>
            <button className="btn btn-secondary" onClick={switchToEdit}>Let me revise first</button>
            <button className="btn btn-ghost" onClick={loadPreview} disabled={loadingPreview}>
              {loadingPreview ? 'Analyzing...' : 'Preview the mapping'}
            </button>
          </div>

        </div>

        <div className="step-actions">
          <button className="btn btn-ghost" onClick={prevStep}>Back</button>
          <div />
        </div>

        {preview && (
          <Modal
            open={showMappingModal}
            onClose={() => setShowMappingModal(false)}
            title="Priority → Capability Mapping"
            className="modal-wide"
          >
            <MappingDiagram
              priorities={draft.audience.priorities.map(p => ({ id: p.id, text: p.text, rank: p.rank }))}
              elements={draft.offering.elements.map(e => ({ id: e.id, text: e.text }))}
              mappings={buildMappingsFromPreview(preview, draft)}
              audienceName={draft.audience.name}
              offeringName={draft.offering.name}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => { setShowMappingModal(false); switchToEdit(); }}>Revise list</button>
              <button className="btn btn-primary" onClick={() => { setShowMappingModal(false); nextStep(); }}>Use this list</button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div className="step-panel">
      <h2>Tell Me About Your Audience</h2>
      <p className="step-description">
        Now let's understand what {draft.audience.name} cares about. Maria will help you discover the obvious priorities and the hidden ones. For each, we need to know why it matters to them.
      </p>

      <div className="coaching-layout">
        <CoachingChat
          draftId={draft.id}
          step={3}
          initialPrompt={`I'd like to understand the priorities of "${draft.audience.name}" when evaluating something like "${draft.offering.name}".`}
          onExtractItem={addPriority}
        />

        <div className="extracted-sidebar">
          <h3>Priorities ({draft.audience.priorities.length})</h3>
          <PriorityList
            audienceId={draft.audienceId}
            audienceName={draft.audience.name}
            priorities={draft.audience.priorities}
            onUpdate={loadDraft}
            showMotivatingFactor={true}
            allowAdd={true}
            allowRemove={true}
          />
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep} disabled={draft.audience.priorities.length < 2}>
          Next: Build My Message ({draft.audience.priorities.length} priorities)
        </button>
      </div>
    </div>
  );
}
