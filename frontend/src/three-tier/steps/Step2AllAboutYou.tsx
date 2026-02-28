import { useState } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { DifferentiatorList } from '../../shared/DifferentiatorList';
import { api } from '../../api/client';

export function Step2AllAboutYou({ draft, loadDraft, nextStep, prevStep }: StepProps) {
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
