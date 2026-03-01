import { useState, useEffect } from 'react';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { Spinner } from '../../shared/Spinner';

interface Question {
  question: string;
  priorityId: string;
  elementId: string;
}

interface TierResult {
  tier1: { text: string; priorityId: string };
  tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
}

export function Step4BuildMessage({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [phase, setPhase] = useState<'building' | 'questions' | 'applying' | 'done'>('building');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, boolean>>({});
  const [currentQ, setCurrentQ] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    // Check if we already have tier statements (resuming)
    if (draft.tier1Statement && draft.tier2Statements.length > 0) {
      setPhase('done');
      return;
    }
    buildMessage();
  }, []);

  async function buildMessage() {
    setPhase('building');
    setError('');
    try {
      const res = await api.post<{
        status: 'complete' | 'questions';
        result: TierResult | null;
        questions: Question[];
      }>('/ai/build-message', { draftId: draft.id });

      if (res.status === 'complete' && res.result) {
        await applyResult(res.result);
      } else if (res.status === 'questions') {
        setQuestions(res.questions);
        setCurrentQ(0);
        setPhase('questions');
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong building your message.');
      setPhase('building');
    }
  }

  async function submitAnswers() {
    setPhase('applying');
    try {
      const answerList = questions.map((q, i) => ({
        priorityId: q.priorityId,
        elementId: q.elementId,
        confirmed: answers[i] !== false, // default to confirmed if not explicitly rejected
      }));

      const res = await api.post<{
        status: 'complete';
        result: TierResult;
      }>('/ai/resolve-questions', { draftId: draft.id, answers: answerList });

      if (res.result) {
        await applyResult(res.result);
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
      setPhase('questions');
    }
  }

  async function applyResult(tierResult: TierResult) {
    setPhase('applying');
    try {
      // Apply tier1
      await api.put(`/tiers/${draft.id}/tier1`, { text: tierResult.tier1.text, changeSource: 'ai_generate' });

      // Apply tier2 + tier3 in bulk
      await api.post(`/tiers/${draft.id}/tier2/bulk`, {
        statements: tierResult.tier2.map((t2, i) => ({
          text: t2.text,
          priorityId: t2.priorityId,
          categoryLabel: t2.categoryLabel || '',
          sortOrder: i,
        })),
        changeSource: 'ai_generate',
      });

      // Apply tier3 bullets
      await loadDraft();

      // Fetch updated draft to get tier2 IDs, then apply tier3
      const { draft: updated } = await api.get<{ draft: typeof draft }>(`/drafts/${draft.id}`);
      for (let i = 0; i < tierResult.tier2.length && i < updated.tier2Statements.length; i++) {
        if (tierResult.tier2[i].tier3?.length) {
          await api.post(`/tiers/${draft.id}/tier2/${updated.tier2Statements[i].id}/tier3/bulk`, {
            bullets: tierResult.tier2[i].tier3,
            changeSource: 'ai_generate',
          });
        }
      }

      // Create initial snapshot
      await api.post(`/versions/table/${draft.id}`, { label: 'Initial generation' });

      await loadDraft();
      setPhase('done');
    } catch (err: any) {
      setError(err.message || 'Failed to apply the generated message.');
    }
  }

  function handleAnswer(questionIndex: number, confirmed: boolean) {
    setAnswers(prev => ({ ...prev, [questionIndex]: confirmed }));
    if (questionIndex < questions.length - 1) {
      setCurrentQ(questionIndex + 1);
    }
  }

  // Auto-advance to step 5 when done
  useEffect(() => {
    if (phase === 'done') {
      const timer = setTimeout(() => nextStep(), 1500);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  return (
    <div className="step-panel" style={{ maxWidth: 700, textAlign: 'center' }}>
      {phase === 'building' && (
        <div style={{ padding: '60px 0' }}>
          <Spinner size={32} />
          <h2 style={{ marginTop: 24 }}>Maria is building your message</h2>
          <p className="step-description">
            Connecting your capabilities to what {draft.audience.name} cares about...
          </p>
          {error && (
            <div style={{ marginTop: 24 }}>
              <p style={{ color: 'var(--danger)' }}>{error}</p>
              <button className="btn btn-primary" onClick={buildMessage} style={{ marginTop: 12 }}>Try Again</button>
            </div>
          )}
        </div>
      )}

      {phase === 'questions' && questions.length > 0 && (
        <div style={{ padding: '40px 0', textAlign: 'left' }}>
          <h2>Maria has a few questions</h2>
          <p className="step-description" style={{ marginBottom: 24 }}>
            A couple of connections weren't obvious. Quick answers will make the message stronger.
          </p>

          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', padding: 24, marginBottom: 24 }}>
            <p style={{ fontSize: 16, lineHeight: 1.6, marginBottom: 20 }}>
              {questions[currentQ].question}
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                className="btn btn-primary"
                onClick={() => handleAnswer(currentQ, true)}
              >
                You're right
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => handleAnswer(currentQ, false)}
              >
                No, skip that connection
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              Question {currentQ + 1} of {questions.length}
            </span>
            {Object.keys(answers).length === questions.length && (
              <button className="btn btn-primary" onClick={submitAnswers}>
                Build My Message
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'applying' && (
        <div style={{ padding: '60px 0' }}>
          <Spinner size={32} />
          <h2 style={{ marginTop: 24 }}>Generating your Three Tier</h2>
          <p className="step-description">Almost there...</p>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ padding: '60px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>&#10003;</div>
          <h2>Your Three Tier is ready</h2>
          <p className="step-description">Taking you there now...</p>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        {phase === 'done' && (
          <button className="btn btn-primary" onClick={nextStep}>
            See My Three Tier
          </button>
        )}
      </div>
    </div>
  );
}
