import type { GuidedStage } from './types';

interface Props {
  currentStage: GuidedStage;
  completedStages: Set<GuidedStage>;
  onNavigate: (stage: GuidedStage) => void;
  onReset?: () => void;
}

const STAGES: { key: GuidedStage; label: string; description: string }[] = [
  { key: 'inputs', label: 'The basics', description: 'What you offer and who you\'re writing to' },
  { key: 'foundation', label: 'Your message', description: 'The core of what you want to say' },
  { key: 'deliverable', label: 'First draft', description: 'Something you can send or refine' },
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
