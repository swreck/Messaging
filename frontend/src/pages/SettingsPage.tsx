import { useEffect, useState } from 'react';
import { useMaria } from '../shared/MariaContext';
import { ConfirmModal } from '../shared/ConfirmModal';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AdminPanel } from '../admin/AdminPanel';
import { StylePicker, type StyleValue } from '../shared/StylePicker';
import type { PersonalizeProfile } from '../types';

interface LearningData {
  questionsSeen: number;
  questionsConfirmed: number;
  questionThreshold: number;
  columnEdits: Record<string, number>;
  corrections: { aiText: string; userText: string; column: string; createdAt: string }[];
}

// Round C — human label for a style enum value.
function labelFor(style: 'TABLE_FOR_2' | 'ENGINEERING_TABLE' | 'PERSONALIZED'): string {
  if (style === 'ENGINEERING_TABLE') return 'Engineering Table';
  if (style === 'PERSONALIZED') return 'Personalized';
  return 'Table for 2';
}

export function SettingsPage() {
  const { setPageContext } = useMaria();
  const { user } = useAuth();
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [personalizeProfile, setPersonalizeProfile] = useState<PersonalizeProfile | null>(null);
  const [showPersonalizeResetConfirm, setShowPersonalizeResetConfirm] = useState(false);
  const [resettingPersonalize, setResettingPersonalize] = useState(false);
  const [showAllObservations, setShowAllObservations] = useState(false);

  // Round C2 — default style settings.
  const [styleSettings, setStyleSettings] = useState<{
    user: { defaultStyle: StyleValue };
    workspace: { id: string; name: string; defaultStyle: StyleValue } | null;
    effective: 'TABLE_FOR_2' | 'ENGINEERING_TABLE' | 'PERSONALIZED';
  } | null>(null);
  const [styleSaving, setStyleSaving] = useState(false);
  const [orgStyleSaving, setOrgStyleSaving] = useState(false);

  useEffect(() => {
    setPageContext({ page: 'settings' });
    loadSettings();
    loadPersonalize();
    loadStyle();
  }, [setPageContext]);

  async function loadStyle() {
    try {
      const data = await api.get<typeof styleSettings extends infer T ? T : never>('/settings/style');
      setStyleSettings(data as any);
    } catch {/* non-fatal */}
  }

  async function saveDefaultStyle(next: StyleValue) {
    setStyleSaving(true);
    try {
      await api.put('/settings/style', { defaultStyle: next });
      await loadStyle();
    } catch {/* non-fatal */} finally {
      setStyleSaving(false);
    }
  }

  async function saveOrgStyle(next: StyleValue) {
    setOrgStyleSaving(true);
    try {
      await api.put('/settings/workspace-style', { defaultStyle: next });
      await loadStyle();
    } catch {/* non-fatal */} finally {
      setOrgStyleSaving(false);
    }
  }

  async function loadSettings() {
    const { settings } = await api.get<{ settings: { learning?: LearningData; voiceCheckEnabled?: boolean } }>('/settings');
    setLearning(settings.learning || null);
  }

  async function loadPersonalize() {
    try {
      const { profile } = await api.get<{ profile: PersonalizeProfile }>('/personalize/profile');
      setPersonalizeProfile(profile);
    } catch {}
  }

  async function handleReset() {
    setShowResetConfirm(false);
    setResetting(true);
    await api.delete('/settings/learning');
    setLearning(null);
    setResetting(false);
  }

  async function handlePersonalizeReset() {
    setShowPersonalizeResetConfirm(false);
    setResettingPersonalize(true);
    await api.delete('/personalize/profile');
    setPersonalizeProfile(null);
    setResettingPersonalize(false);
  }

  async function togglePersonalize() {
    if (!personalizeProfile) return;
    const newEnabled = !personalizeProfile.enabled;
    await api.put('/personalize/toggle', { enabled: newEnabled });
    setPersonalizeProfile(prev => prev ? { ...prev, enabled: newEnabled } : null);
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

      {user?.isAdmin && (
        <div style={{ marginTop: 24 }}>
          <AdminPanel />
          <hr className="settings-divider" />
        </div>
      )}

      {styleSettings && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Default Style</h2>
          <p className="text-secondary" style={{ marginBottom: 16, lineHeight: 1.5 }}>
            Maria's voice for everything she generates. You can override this on any individual deliverable.
            {styleSettings.user.defaultStyle === '' && styleSettings.workspace?.defaultStyle ? (
              <> Right now your default falls through to your organization's setting (<strong>{labelFor(styleSettings.effective)}</strong>).</>
            ) : (
              <> Active: <strong>{labelFor(styleSettings.effective)}</strong>.</>
            )}
          </p>
          <StylePicker
            value={styleSettings.user.defaultStyle}
            onChange={saveDefaultStyle}
            allowDefault={!!styleSettings.workspace}
            label="Your default style"
            hint={styleSettings.workspace ? `Your organization's default is ${labelFor((styleSettings.workspace.defaultStyle || 'TABLE_FOR_2') as any)}. Pick "Use my default" to follow it.` : undefined}
            disabled={styleSaving}
          />
          {styleSettings.workspace && user?.isAdmin && (
            <div style={{ marginTop: 24 }}>
              <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>Organization default ({styleSettings.workspace.name})</h3>
              <p className="text-secondary" style={{ marginBottom: 8, lineHeight: 1.5 }}>
                Sets the default for new users in this workspace. Each member can override their own setting above.
              </p>
              <StylePicker
                value={styleSettings.workspace.defaultStyle}
                onChange={saveOrgStyle}
                allowDefault={false}
                label="Organization default"
                disabled={orgStyleSaving}
              />
            </div>
          )}
          {styleSettings.effective === 'PERSONALIZED' && personalizeProfile && personalizeProfile.observations.length === 0 && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--accent-light, #eaf4ff)', border: '1px solid var(--accent, #007aff)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
              Personalized active, but I don't have your voice profile yet. Maria falls back to Table for 2 until you train her — drop two or three emails into chat to start.
            </div>
          )}
          <hr className="settings-divider" style={{ marginTop: 32 }} />
        </div>
      )}

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
                onClick={() => setShowResetConfirm(true)}
                disabled={resetting}
                style={{ color: 'var(--danger)' }}
              >
                {resetting ? 'Resetting...' : 'Reset Maria\'s Memory'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Personal Writing Style */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Personal Writing Style</h2>
        <p className="text-secondary" style={{ marginBottom: 24, lineHeight: 1.5 }}>
          Maria can learn your personal writing style and apply it when generating
          Five Chapter Stories. Tell her about your style through an interview,
          or share writing samples in the chat.
        </p>

        {personalizeProfile && personalizeProfile.observations.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ padding: 16, background: 'var(--bg-secondary)', borderRadius: 'var(--radius)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>
                Style observations ({personalizeProfile.observations.length})
              </div>
              {personalizeProfile.observations.slice(0, showAllObservations ? undefined : 5).map((obs, i) => (
                <div key={i} className="text-secondary" style={{ fontSize: 14, marginBottom: 4, lineHeight: 1.5 }}>
                  {obs.text}
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                    ({obs.source}{obs.confidence >= 0.8 ? ', high confidence' : ''})
                  </span>
                </div>
              ))}
              {personalizeProfile.observations.length > 5 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowAllObservations(!showAllObservations)}
                  style={{ marginTop: 8, fontSize: 13 }}
                >
                  {showAllObservations ? 'Show fewer' : `Show all ${personalizeProfile.observations.length}`}
                </button>
              )}
            </div>

            {personalizeProfile.restrictions.length > 0 && (
              <div style={{ padding: 16, background: 'var(--bg-secondary)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  Restrictions ({personalizeProfile.restrictions.length})
                </div>
                {personalizeProfile.restrictions.map((r, i) => (
                  <div key={i} className="text-secondary" style={{ fontSize: 14, marginBottom: 4 }}>
                    {r.text}
                  </div>
                ))}
              </div>
            )}

            {personalizeProfile.documents.length > 0 && (
              <div style={{ padding: 16, background: 'var(--bg-secondary)', borderRadius: 'var(--radius)' }}>
                <div className="text-secondary" style={{ fontSize: 14 }}>
                  {personalizeProfile.documents.length} writing sample{personalizeProfile.documents.length !== 1 ? 's' : ''} analyzed
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => document.dispatchEvent(new CustomEvent('maria-toggle', { detail: { open: true, message: "I want to adjust my personal writing style" } }))}
              >
                Refine with Maria
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => document.dispatchEvent(new CustomEvent('maria-toggle', { detail: { open: true, message: "I have a writing sample for my personalization" } }))}
              >
                Add a Writing Sample
              </button>
            </div>

            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={personalizeProfile.enabled} onChange={togglePersonalize} />
                Enable personalization
              </label>
              <button
                className="btn btn-ghost"
                onClick={() => setShowPersonalizeResetConfirm(true)}
                disabled={resettingPersonalize}
                style={{ color: 'var(--danger)' }}
              >
                {resettingPersonalize ? 'Resetting...' : 'Reset Style Profile'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{
            padding: 24,
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
          }}>
            No style profile yet. Open the Maria chat and say "Let's set up my writing style" to get started,
            or tap the Personalize button on any Five Chapter Story page.
          </div>
        )}
      </div>

      <ConfirmModal
        open={showResetConfirm}
        title="Reset Maria's Memory?"
        message="This will clear all of Maria's learned preferences — question calibration, column edit patterns, and correction history. This cannot be undone."
        confirmLabel="Reset"
        confirmDanger
        onConfirm={handleReset}
        onClose={() => setShowResetConfirm(false)}
      />

      <ConfirmModal
        open={showPersonalizeResetConfirm}
        title="Reset Style Profile?"
        message="This will erase your entire personalization profile — style observations, restrictions, and analyzed documents. You'll need to redo the interview to use Personalize again."
        confirmLabel="Reset"
        confirmDanger
        onConfirm={handlePersonalizeReset}
        onClose={() => setShowPersonalizeResetConfirm(false)}
      />
    </div>
  );
}
