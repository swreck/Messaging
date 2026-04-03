import { useEffect, useState } from 'react';
import { useMaria } from '../shared/MariaContext';
import { api } from '../api/client';

interface LearningData {
  questionsSeen: number;
  questionsConfirmed: number;
  questionThreshold: number;
  columnEdits: Record<string, number>;
  corrections: { aiText: string; userText: string; column: string; createdAt: string }[];
}

export function SettingsPage() {
  const { setPageContext } = useMaria();
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    setPageContext({ page: 'settings' });
    loadSettings();
  }, [setPageContext]);

  async function loadSettings() {
    const { settings } = await api.get<{ settings: { learning?: LearningData; voiceCheckEnabled?: boolean } }>('/settings');
    setLearning(settings.learning || null);
  }

  async function handleReset() {
    if (!confirm('Reset all of Maria\'s learned preferences? This cannot be undone.')) return;
    setResetting(true);
    await api.delete('/settings/learning');
    setLearning(null);
    setResetting(false);
  }

  const hasLearning = learning && (
    learning.questionsSeen > 0 ||
    Object.keys(learning.columnEdits).length > 0 ||
    learning.corrections.length > 0
  );

  const totalColumnEdits = learning
    ? Object.values(learning.columnEdits).reduce((s, n) => s + n, 0)
    : 0;

  const topColumns = learning
    ? Object.entries(learning.columnEdits)
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];

  const confirmRate = learning && learning.questionsSeen > 0
    ? Math.round((learning.questionsConfirmed / learning.questionsSeen) * 100)
    : null;

  return (
    <div className="page-container">
      <h1>Settings</h1>

      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Maria's Memory</h2>
        <p className="text-secondary" style={{ marginBottom: 24, lineHeight: 1.5 }}>
          Maria learns from how you work — which columns you edit most, how often you agree
          with her mapping suggestions. She uses this to make better first drafts over time.
        </p>

        {!hasLearning ? (
          <div style={{
            padding: 24,
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
          }}>
            Maria hasn't learned anything yet. As you edit messages and answer her questions,
            she'll start picking up on your preferences.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Question confidence */}
            {learning!.questionsSeen > 0 && (
              <div style={{
                padding: 16,
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Question calibration</div>
                <div className="text-secondary" style={{ fontSize: 15, lineHeight: 1.5 }}>
                  Maria has asked {learning!.questionsSeen} question{learning!.questionsSeen !== 1 ? 's' : ''} about
                  uncertain mappings. You confirmed {confirmRate}% of them.
                  {learning!.questionThreshold !== 0.75 && (
                    <> She's adjusted her threshold to {learning!.questionThreshold.toFixed(2)} — {
                      learning!.questionThreshold > 0.75
                        ? 'asking fewer questions since you usually agree.'
                        : 'asking more questions since she should double-check more often.'
                    }</>
                  )}
                </div>
              </div>
            )}

            {/* Column editing patterns */}
            {totalColumnEdits > 0 && (
              <div style={{
                padding: 16,
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Column editing patterns</div>
                <div className="text-secondary" style={{ fontSize: 15, lineHeight: 1.5 }}>
                  You've manually edited {totalColumnEdits} statement{totalColumnEdits !== 1 ? 's' : ''} after generation.
                  {topColumns.length > 0 && (
                    <> Maria pays extra attention to the {topColumns.map(([col]) => col).join(', ')} column{topColumns.length > 1 ? 's' : ''} because you refine {topColumns.length > 1 ? 'them' : 'it'} most often.</>
                  )}
                </div>
              </div>
            )}

            {/* Corrections stored */}
            {learning!.corrections.length > 0 && (
              <div style={{
                padding: 16,
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Correction history</div>
                <div className="text-secondary" style={{ fontSize: 15 }}>
                  {learning!.corrections.length} edit{learning!.corrections.length !== 1 ? 's' : ''} recorded for future vocabulary learning.
                </div>
              </div>
            )}

            <div style={{ marginTop: 8 }}>
              <button
                className="btn btn-ghost"
                onClick={handleReset}
                disabled={resetting}
                style={{ color: 'var(--danger)' }}
              >
                {resetting ? 'Resetting...' : 'Reset Maria\'s Memory'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
