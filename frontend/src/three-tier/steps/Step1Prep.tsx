import type { StepProps } from './types';

export function Step1Prep({ draft, nextStep, goToStep }: StepProps) {
  const isReturning = draft.currentStep > 1;

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

      <div style={{ margin: '20px 0', padding: '16px 20px', background: 'var(--bg-secondary, #f8f8fa)', borderRadius: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
          Here's the plan:
        </p>
        <ol style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>You'll tell Maria about what makes {draft.offering.name} special</li>
          <li>Then about what {draft.audience.name} cares about</li>
          <li>Maria builds your three-tier message</li>
          <li>You review, refine, and make it yours</li>
        </ol>
      </div>

      <div className="step-actions">
        <div />
        {isReturning ? (
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
              You were on: <strong style={{ color: 'var(--text-secondary)' }}>
                {['Confirm', 'Your Offering', 'Your Audience', 'Building', 'Your Three Tier'][draft.currentStep - 1] || `Step ${draft.currentStep}`}
              </strong>
            </p>
            <button className="btn btn-primary btn-lg" style={{ fontSize: 16, padding: '12px 28px' }} onClick={() => goToStep(draft.currentStep)}>
              Continue where I left off
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={nextStep}>
            Looks Good — Let's Go
          </button>
        )}
      </div>
    </div>
  );
}
