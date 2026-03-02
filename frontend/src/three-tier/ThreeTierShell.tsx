import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ProgressBar } from './ProgressBar';
import { Spinner } from '../shared/Spinner';
import { Step1Prep } from './steps/Step1Prep';
import { Step2AllAboutYou } from './steps/Step2AllAboutYou';
import { Step3YourAudience } from './steps/Step3YourAudience';
import { Step4BuildMessage } from './steps/Step4BuildMessage';
import { Step5ThreeTier } from './steps/Step5ThreeTier';
import { useMaria } from '../shared/MariaContext';
import type { ThreeTierDraft } from '../types';

const AUTO_SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function ThreeTierShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [, setLoading] = useState(true);
  const [activeStep, setActiveStepInternal] = useState(1);
  const [navigating, setNavigating] = useState(false);
  const lastInteraction = useRef(Date.now());
  const initialLoadDone = useRef(false);

  // Sync activeStep from URL when back/forward is pressed
  useEffect(() => {
    const urlStep = searchParams.get('step');
    if (urlStep) {
      const parsed = parseInt(urlStep, 10);
      if (parsed >= 1 && parsed <= 5 && parsed !== activeStep) {
        setActiveStepInternal(parsed);
      }
    }
  }, [searchParams]);

  // Navigate to step — pushes browser history entry
  function navigateToStep(step: number) {
    setActiveStepInternal(step);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('step', String(step));
      next.delete('mode');
      return next;
    });
  }

  // Track user interaction for auto-save
  useEffect(() => {
    function onActivity() { lastInteraction.current = Date.now(); }
    window.addEventListener('click', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => { window.removeEventListener('click', onActivity); window.removeEventListener('keydown', onActivity); };
  }, []);

  // Auto-save snapshot every 5 minutes on Step 5
  const autoSave = useCallback(async () => {
    if (!draftId || activeStep !== 5) return;
    // Only auto-save if user was active in the last 10 minutes
    if (Date.now() - lastInteraction.current > 10 * 60 * 1000) return;
    try {
      await api.post(`/versions/table/${draftId}`, { label: 'Auto-save' });
    } catch { /* silent */ }
  }, [draftId, activeStep]);

  useEffect(() => {
    const timer = setInterval(autoSave, AUTO_SAVE_INTERVAL);
    return () => clearInterval(timer);
  }, [autoSave]);

  const { setPageContext, registerRefresh } = useMaria();

  useEffect(() => {
    if (draftId) loadDraft();
  }, [draftId]);

  // Register page context for Maria assistant
  useEffect(() => {
    setPageContext({
      page: 'three-tier',
      draftId: draftId || undefined,
      audienceId: draft?.audienceId,
      offeringId: draft?.offeringId,
    });
    registerRefresh(loadDraft);
  }, [draftId, draft?.audienceId]);

  async function loadDraft() {
    setLoading(true);
    try {
      const { draft } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(draft);
      if (!initialLoadDone.current) {
        initialLoadDone.current = true;
        const urlStep = searchParams.get('step');
        const step = urlStep ? parseInt(urlStep, 10) : draft.currentStep;
        setActiveStepInternal(step);
        if (!urlStep) {
          setSearchParams({ step: String(step) }, { replace: true });
        }
      }
    } catch {
      navigate('/');
    } finally {
      setLoading(false);
    }
  }

  // Silent refresh — updates draft data without unmounting step components
  async function refreshDraft() {
    try {
      const { draft } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(draft);
    } catch {
      // silent — draft is already loaded, just couldn't refresh
    }
  }

  async function goToStep(step: number) {
    if (!draftId || navigating) return;
    setNavigating(true);
    try {
      navigateToStep(step);
      if (step > (draft?.currentStep || 1)) {
        await api.patch(`/drafts/${draftId}`, { currentStep: step });
        setDraft(prev => prev ? { ...prev, currentStep: step } : prev);
      }
    } finally {
      setNavigating(false);
    }
  }

  async function nextStep() {
    await goToStep(activeStep + 1);
  }

  function prevStep() {
    if (activeStep > 1) navigateToStep(activeStep - 1);
  }

  if (!draft) return <div className="loading-screen"><Spinner size={32} /></div>;

  const stepProps = { draft, loadDraft, refreshDraft, nextStep, prevStep, goToStep };

  return (
    <div className="three-tier-shell">
      <ProgressBar activeStep={activeStep} maxStep={draft.currentStep} onStepClick={navigateToStep} />
      <div className="step-content">
        {activeStep === 1 && <Step1Prep {...stepProps} />}
        {activeStep === 2 && <Step2AllAboutYou {...stepProps} />}
        {activeStep === 3 && <Step3YourAudience {...stepProps} />}
        {activeStep === 4 && <Step4BuildMessage {...stepProps} />}
        {activeStep === 5 && <Step5ThreeTier {...stepProps} />}
      </div>
    </div>
  );
}
