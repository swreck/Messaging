import type { GuidedStage } from './types';

interface Props {
  currentStage: GuidedStage;
  completedStages: Set<GuidedStage>;
  onNavigate: (stage: GuidedStage) => void;
  onReset?: () => void;
}

const STAGES: { key: GuidedStage; label: string; description: string }[] = [
  { key: 'inputs', label: 'Inputs', description: 'What makes you different and what your audience cares about' },
  { key: 'foundation', label: 'Foundation', description: 'Your foundational message connecting priorities to strengths' },
  { key: 'deliverable', label: 'Deliverable', description: 'A first draft you can refine and send' },
];

export function ProcessBar({ currentStage, completedStages, onNavigate, onReset }: Props) {
  return (
    <div className="guided-process-bar">
      {STAGES.map((stage, i) => {
        const isComplete = completedStages.has(stage.key);
        const isCurrent = currentStage === stage.key;
        const isClickable = isComplete && !isCurrent;

        return (
          <div key={stage.key} className="guided-process-stage-wrapper">
            {i > 0 && (
              <div className={`guided-process-connector ${isComplete || isCurrent ? 'guided-process-connector-active' : ''}`} />
            )}
            <button
              type="button"
              className={`guided-process-stage ${isCurrent ? 'guided-process-stage-current' : ''} ${isComplete ? 'guided-process-stage-complete' : ''} ${!isComplete && !isCurrent ? 'guided-process-stage-future' : ''}`}
              onClick={() => isClickable && onNavigate(stage.key)}
              disabled={!isClickable}
              title={stage.description}
            >
              <span className="guided-process-indicator">
                {isComplete ? '✓' : isCurrent ? '●' : '○'}
              </span>
              <span className="guided-process-label">{stage.label}</span>
            </button>
          </div>
        );
      })}
      {onReset && (
        <button
          type="button"
          className="guided-process-reset"
          onClick={onReset}
          title="Start a new message"
        >
          + New
        </button>
      )}
    </div>
  );
}
