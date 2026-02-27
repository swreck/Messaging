import type { StepProps } from './types';
import { InfoTooltip } from '../../shared/InfoTooltip';

export function Step1Prep({ draft, nextStep }: StepProps) {
  return (
    <div className="step-panel">
      <h2>
        Step 1: Preparation
        <InfoTooltip text="Gather any existing materials: product descriptions, emails, brochures, website copy, testimonials. Avoid the blank page." />
      </h2>
      <p className="step-description">
        Before we start coaching, let's make sure you have what you need. Gather any existing materials about your offering — product descriptions, emails, brochures, website copy, customer testimonials, whatever you have. It's fine to have nothing — everything you need might be in your head.
      </p>

      <div className="entity-card" style={{ marginBottom: 16 }}>
        <div className="entity-card-header">
          <h3>{draft.offering.name}</h3>
        </div>
        {draft.offering.smeRole && <div className="entity-card-meta">Your role: {draft.offering.smeRole}</div>}
        {draft.offering.description && <p className="entity-card-desc">{draft.offering.description}</p>}
        <div className="entity-card-count">
          {draft.offering.elements.length > 0
            ? `${draft.offering.elements.length} capability${draft.offering.elements.length !== 1 ? 'ies' : 'y'} already captured`
            : 'No capabilities captured yet — we\'ll do that in the next step'}
        </div>
      </div>

      <div className="entity-card">
        <div className="entity-card-header">
          <h3>Audience: {draft.audience.name}</h3>
        </div>
        {draft.audience.description && <p className="entity-card-desc">{draft.audience.description}</p>}
        <div className="entity-card-count">
          {draft.audience.priorities.length > 0
            ? `${draft.audience.priorities.length} priorit${draft.audience.priorities.length !== 1 ? 'ies' : 'y'} already captured`
            : 'No priorities captured yet — we\'ll do that in Step 4'}
        </div>
      </div>

      <div className="step-actions">
        <div />
        <button className="btn btn-primary" onClick={nextStep}>
          Ready — Let's Go
        </button>
      </div>
    </div>
  );
}
