import type { StepProps } from './types';

export function Step1Prep({ draft, nextStep }: StepProps) {
  return (
    <div className="step-panel">
      <h2>Before We Begin</h2>
      <p className="step-description">
        Confirm your offering and audience before building.
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
            : 'No capabilities captured yet'}
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
            : 'No priorities captured yet'}
        </div>
      </div>

      <div className="step-actions">
        <div />
        <button className="btn btn-primary" onClick={nextStep}>
          Looks Good — Let's Go
        </button>
      </div>
    </div>
  );
}
