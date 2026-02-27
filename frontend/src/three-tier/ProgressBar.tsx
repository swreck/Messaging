const STEP_LABELS = [
  'Prep',
  'All About You',
  'Pick Audience',
  'All About Audience',
  'Draw Lines',
  'Convert Lines',
  'Three Tier Table',
  'Magic Hour',
];

interface ProgressBarProps {
  currentStep: number;
  onStepClick: (step: number) => void;
}

export function ProgressBar({ currentStep, onStepClick }: ProgressBarProps) {
  return (
    <div className="progress-bar">
      {STEP_LABELS.map((label, i) => {
        const step = i + 1;
        const isCompleted = step < currentStep;
        const isCurrent = step === currentStep;

        return (
          <div key={step} className="progress-step">
            {i > 0 && <div className={`progress-connector${isCompleted ? ' completed' : ''}`} />}
            <div
              className={`progress-dot${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}`}
              onClick={() => step <= currentStep && onStepClick(step)}
              title={label}
            >
              {isCompleted ? '\u2713' : step}
            </div>
            <span className={`progress-label${isCurrent ? ' current' : ''}`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
