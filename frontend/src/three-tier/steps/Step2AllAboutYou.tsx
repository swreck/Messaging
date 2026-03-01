import { useState } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { DifferentiatorList } from '../../shared/DifferentiatorList';
import { api } from '../../api/client';

interface MappingPreview {
  mappings: { priorityText: string; rank: number; capabilities: string[]; confidence: number }[];
  gaps: string[];
  orphans: string[];
}

export function Step2AllAboutYou({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const hasEnough = draft.offering.elements.length >= 3;
  const [mode, setMode] = useState<'confirm' | 'edit'>(hasEnough ? 'confirm' : 'edit');
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [elements, setElements] = useState(draft.offering.elements.map(e => e.text));

  async function addElement(text: string) {
    if (!text.trim()) return;
    if (elements.includes(text.trim())) return;

    await api.post(`/offerings/${draft.offeringId}/elements`, {
      text: text.trim(),
      source: 'ai_extracted',
    });
    setElements(prev => [...prev, text.trim()]);
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
          <h2>Your Offering's Differentiators</h2>
          <ol className="confirm-list">
            {draft.offering.elements.map(el => (
              <li key={el.id} className="confirm-list-item">
                <span>{el.text}</span>
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
      <h2>Tell Me About Your Offering</h2>
      <p className="step-description">
        Let's build a list of everything that makes {draft.offering.name} special. Maria will ask you questions — items she identifies will appear in the sidebar. You can also add your own.
      </p>

      <div className="coaching-layout">
        <CoachingChat
          draftId={draft.id}
          step={2}
          initialPrompt={`I'd like to understand what makes "${draft.offering.name}" special. Let's start.`}
          onExtractItem={addElement}
        />

        <div className="extracted-sidebar">
          <h3>Capabilities ({draft.offering.elements.length})</h3>
          <DifferentiatorList
            offeringId={draft.offeringId}
            elements={draft.offering.elements}
            onUpdate={loadDraft}
            allowAdd={true}
            allowRemove={true}
          />
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep} disabled={draft.offering.elements.length < 3}>
          Next: Your Audience ({draft.offering.elements.length} items)
        </button>
      </div>
    </div>
  );
}
