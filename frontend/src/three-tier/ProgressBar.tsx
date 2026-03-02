const STEP_LABELS = [
  'Confirm',
  'Your Offering',
  'Your Audience',
  'Building',
  'Your Three Tier',
];

interface ProgressBarProps {
  activeStep: number;
  maxStep: number;
  onStepClick: (step: number) => void;
}

export function ProgressBar({ activeStep, maxStep, onStepClick }: ProgressBarProps) {
  return (
    <div className="progress-bar">
      {STEP_LABELS.map((label, i) => {
        const step = i + 1;
        const isReachable = step <= maxStep;
        const isCompleted = step < activeStep;
        const isCurrent = step === activeStep;

        return (
          <div key={step} className="progress-step">
            {i > 0 && <div className={`progress-connector${isCompleted ? ' completed' : ''}`} />}
            <div
              className={`progress-dot${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}${!isReachable ? ' disabled' : ''}`}
              onClick={() => isReachable && onStepClick(step)}
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
