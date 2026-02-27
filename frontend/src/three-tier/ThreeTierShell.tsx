import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ProgressBar } from './ProgressBar';
import { Spinner } from '../shared/Spinner';
import { Step1Prep } from './steps/Step1Prep';
import { Step2AllAboutYou } from './steps/Step2AllAboutYou';
import { Step3PickAudience } from './steps/Step3PickAudience';
import { Step4AllAboutAudience } from './steps/Step4AllAboutAudience';
import { Step5DrawLines } from './steps/Step5DrawLines';
import { Step6ConvertLines } from './steps/Step6ConvertLines';
import { Step7ThreeTierTable } from './steps/Step7ThreeTierTable';
import { Step8MagicHour } from './steps/Step8MagicHour';
import type { ThreeTierDraft } from '../types';

export function ThreeTierShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState(1);

  useEffect(() => {
    if (draftId) loadDraft();
  }, [draftId]);

  async function loadDraft() {
    setLoading(true);
    try {
      const { draft } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(draft);
      setActiveStep(draft.currentStep);
    } catch {
      navigate('/');
    } finally {
      setLoading(false);
    }
  }

  async function goToStep(step: number) {
    if (!draftId) return;
    setActiveStep(step);
    if (step > (draft?.currentStep || 1)) {
      await api.patch(`/drafts/${draftId}`, { currentStep: step });
      setDraft(prev => prev ? { ...prev, currentStep: step } : prev);
    }
  }

  async function nextStep() {
    goToStep(activeStep + 1);
  }

  function prevStep() {
    if (activeStep > 1) setActiveStep(activeStep - 1);
  }

  if (loading || !draft) return <div className="loading-screen"><Spinner size={32} /></div>;

  const stepProps = { draft, loadDraft, nextStep, prevStep, goToStep };

  return (
    <div className="three-tier-shell">
      <ProgressBar currentStep={activeStep} onStepClick={setActiveStep} />
      <div className="step-content">
        {activeStep === 1 && <Step1Prep {...stepProps} />}
        {activeStep === 2 && <Step2AllAboutYou {...stepProps} />}
        {activeStep === 3 && <Step3PickAudience {...stepProps} />}
        {activeStep === 4 && <Step4AllAboutAudience {...stepProps} />}
        {activeStep === 5 && <Step5DrawLines {...stepProps} />}
        {activeStep === 6 && <Step6ConvertLines {...stepProps} />}
        {activeStep === 7 && <Step7ThreeTierTable {...stepProps} />}
        {activeStep === 8 && <Step8MagicHour {...stepProps} />}
      </div>
    </div>
  );
}
