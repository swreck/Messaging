import { useState, useEffect, useRef } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { DifferentiatorList } from '../../shared/DifferentiatorList';
import { InfoTooltip } from '../../shared/InfoTooltip';
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

export function Step2AllAboutYou({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const hasEnough = draft.offering.elements.length >= 3;
  const [mode, setMode] = useState<'confirm' | 'edit'>(hasEnough ? 'confirm' : 'edit');
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [elements, setElements] = useState(draft.offering.elements.map(e => e.text));
  const [draftingMfs, setDraftingMfs] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  async function draftMfs() {
    setDraftingMfs(true);
    try {
      await api.post('/ai/draft-mfs', { offeringId: draft.offeringId });
      await loadDraft();
    } finally {
      setDraftingMfs(false);
    }
  }

  useEffect(() => {
    function handleExtracted() {
      if (sidebarRef.current) {
        sidebarRef.current.classList.add('highlight');
        setTimeout(() => sidebarRef.current?.classList.remove('highlight'), 1000);
      }
    }
    window.addEventListener('maria-extracted', handleExtracted);
    return () => window.removeEventListener('maria-extracted', handleExtracted);
  }, []);

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
      setShowMappingModal(true);
    } finally {
      setLoadingPreview(false);
    }
  }

  if (mode === 'confirm') {
    const missingMfCount = draft.offering.elements.filter(e => !e.motivatingFactor).length;
    return (
      <div className="step-panel">
        <div className="confirm-panel">
          <h2>Your Offering's Differentiators</h2>
          <DifferentiatorList
            offeringId={draft.offeringId}
            elements={draft.offering.elements}
            onUpdate={loadDraft}
            readOnly
          />
          {missingMfCount > 0 && (
            <div className="confirm-mf-hint">
              <p style={{ margin: '0 0 8px 0' }}>
                {missingMfCount === draft.offering.elements.length ? 'None' : missingMfCount} of your differentiators {missingMfCount === 1 ? 'is missing a motivating factor' : 'are missing motivating factors'}. Maria can write them — it takes a few extra seconds, one-time.
              </p>
              <button
                className="btn btn-secondary btn-sm"
                onClick={draftMfs}
                disabled={draftingMfs}
              >
                {draftingMfs ? 'Maria is writing them…' : 'Ask Maria to draft motivating factors'}
              </button>
            </div>
          )}

          <div className="confirm-actions">
            <button className="btn btn-primary" onClick={nextStep}>Use this list</button>
            <button className="btn btn-secondary" onClick={() => setMode('edit')}>Let me revise first</button>
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
              <button className="btn btn-secondary" onClick={() => { setShowMappingModal(false); setMode('edit'); }}>Revise list</button>
              <button className="btn btn-primary" onClick={() => { setShowMappingModal(false); nextStep(); }}>Use this list</button>
            </div>
          </Modal>
        )}
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

        <div className="extracted-sidebar" ref={sidebarRef}>
          <h3>Capabilities ({draft.offering.elements.length}) <InfoTooltip text="What makes your offering different or valuable. Maria maps these to what your audience cares about." /></h3>
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
