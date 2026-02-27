import type { ThreeTierDraft } from '../../types';

export interface StepProps {
  draft: ThreeTierDraft;
  loadDraft: () => Promise<void>;
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (step: number) => void;
}
