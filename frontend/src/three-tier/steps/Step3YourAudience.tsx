import { useState } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { PriorityList } from '../../shared/PriorityList';
import { api } from '../../api/client';

interface MappingPreview {
  mappings: { priorityText: string; rank: number; capabilities: string[]; confidence: number }[];
  gaps: string[];
  orphans: string[];
}

export function Step3YourAudience({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const hasEnough = draft.audience.priorities.length >= 2;
  const [mode, setMode] = useState<'confirm' | 'edit'>(hasEnough ? 'confirm' : 'edit');
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

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
              <li key={p.id} className="confirm-list-item">
                <span>{p.text}</span>
                {p.motivatingFactor && (
                  <span className="confirm-list-mf">{p.motivatingFactor}</span>
                )}
              </li>
            ))}
          </ol>

          <div className="confirm-actions">
            <button className="btn btn-primary" onClick={nextStep}>Use this list</button>
            <button className="btn btn-secondary" onClick={() => setMode('edit')}>Let me revise first</button>
            <button className="btn btn-ghost" onClick={loadPreview} disabled={loadingPreview}>
              {loadingPreview ? 'Analyzing...' : 'Preview the mapping'}
            </button>
          </div>

          {loadingPreview && (
            <div className="mapping-preview">
              <p className="mapping-preview-loading">Maria is analyzing the connections...</p>
            </div>
          )}

          {preview && !loadingPreview && (
            <div className="mapping-preview">
              <h3>Mapping Preview</h3>
              {preview.mappings.map((m, i) => (
                <div key={i} className="mapping-preview-group">
                  <div className="mapping-preview-priority">
                    #{m.rank} {m.priorityText}
                  </div>
                  <ul className="mapping-preview-caps">
                    {m.capabilities.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {preview.gaps.length > 0 && (
                <div className="mapping-preview-section">
                  <strong>Gaps</strong> (priorities without matching capabilities)
                  <ul>{preview.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                </div>
              )}
              {preview.orphans.length > 0 && (
                <div className="mapping-preview-section">
                  <strong>Unmatched capabilities</strong>
                  <ul>{preview.orphans.map((o, i) => <li key={i}>{o}</li>)}</ul>
                </div>
              )}

              <div className="confirm-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={nextStep}>Use this list</button>
                <button className="btn btn-secondary" onClick={() => setMode('edit')}>Let me revise first</button>
              </div>
            </div>
          )}
        </div>

        <div className="step-actions">
          <button className="btn btn-ghost" onClick={prevStep}>Back</button>
          <div />
        </div>
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
