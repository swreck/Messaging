import type { StepProps } from './types';
import { InfoTooltip } from '../../shared/InfoTooltip';

export function Step3PickAudience({ draft, nextStep, prevStep }: StepProps) {
  return (
    <div className="step-panel">
      <h2>
        Step 3: Pick Your Audience
        <InfoTooltip text="Two people share an audience only if they have the same problems AND talk about them the same way. Different problems or different language = different audience." />
      </h2>
      <p className="step-description">
        You're building this Three Tier for a specific audience. Make sure this is the right one — the message only works when it's tailored to the people you're trying to reach.
      </p>

      <div className="entity-card" style={{ maxWidth: 480 }}>
        <div className="entity-card-header">
          <h3>{draft.audience.name}</h3>
        </div>
        {draft.audience.description && <p className="entity-card-desc">{draft.audience.description}</p>}
        <div className="entity-card-count">
          {draft.audience.priorities.length > 0
            ? `${draft.audience.priorities.length} priorities already captured — we'll review them next`
            : 'No priorities yet — we\'ll discover them in the next step'}
        </div>
      </div>

      <p style={{ marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
        Remember: two people are in the same audience only if they have the same problems AND talk about those problems in the same way. If your audience is too broad, the message won't resonate.
      </p>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep}>
          This is the right audience — Continue
        </button>
      </div>
    </div>
  );
}
