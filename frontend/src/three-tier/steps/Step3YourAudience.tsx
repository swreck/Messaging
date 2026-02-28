import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { PriorityList } from '../../shared/PriorityList';
import { api } from '../../api/client';

export function Step3YourAudience({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  async function addPriority(text: string) {
    if (!text.trim()) return;
    if (draft.audience.priorities.find(p => p.text === text.trim())) return;

    await api.post(`/audiences/${draft.audienceId}/priorities`, {
      text: text.trim(),
      rank: draft.audience.priorities.length + 1,
    });
    await loadDraft();
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
