import { useState } from 'react';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { Spinner } from '../../shared/Spinner';
import { InfoTooltip } from '../../shared/InfoTooltip';
import type { ConvertLinesResponse } from '../../types';

export function Step6ConvertLines({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<ConvertLinesResponse | null>(null);
  const [applied, setApplied] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      const result = await api.post<ConvertLinesResponse>('/ai/convert-lines', { draftId: draft.id });
      setPreview(result);
    } catch (err: any) {
      alert(`Generation failed: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  }

  async function applyToTable() {
    if (!preview) return;

    // Save Tier 1
    await api.put(`/tiers/${draft.id}/tier1`, { text: preview.tier1.text, changeSource: 'ai_generate' });

    // Save Tier 2 + Tier 3 as bulk
    await api.post(`/tiers/${draft.id}/tier2/bulk`, {
      statements: preview.tier2.map(t2 => ({ text: t2.text, priorityId: t2.priorityId })),
      changeSource: 'ai_generate',
    });

    // Save Tier 3 bullets for each Tier 2
    await loadDraft();

    // Now get the updated draft to find tier2 IDs for tier3 bullets
    const { draft: updated } = await api.get<{ draft: typeof draft }>(`/drafts/${draft.id}`);
    for (let i = 0; i < updated.tier2Statements.length; i++) {
      const t2 = updated.tier2Statements[i];
      const bullets = preview.tier2[i]?.tier3 || [];
      if (bullets.length > 0) {
        await api.post(`/tiers/${draft.id}/tier2/${t2.id}/tier3/bulk`, {
          bullets,
          changeSource: 'ai_generate',
        });
      }
    }

    // Create initial table snapshot
    await api.post(`/versions/table/${draft.id}`, { label: 'Initial Generation' });

    setApplied(true);
    await loadDraft();
  }

  const confirmedMappings = draft.mappings.filter(m => m.status === 'confirmed');

  return (
    <div className="step-panel">
      <h2>
        Step 6: Convert Lines to Statements
        <InfoTooltip text="Each mapping becomes a statement: 'You get [priority] because [capability]'. The #1 priority becomes Tier 1. All others become Tier 2 (under 20 words each)." />
      </h2>
      <p className="step-description">
        Maria will turn your {confirmedMappings.length} confirmed mappings into canonical value statements. Preview them before they go into your Three Tier table.
      </p>

      {!preview && !applied && (
        <button className="btn btn-primary" onClick={generate} disabled={generating}>
          {generating ? <><Spinner size={14} /> Generating statements...</> : 'Generate Statements'}
        </button>
      )}

      {preview && !applied && (
        <div>
          <div className="entity-card" style={{ marginBottom: 16 }}>
            <h3>Tier 1 (Your #1 Message)</h3>
            <p style={{ fontSize: 18, fontWeight: 600, marginTop: 8, color: 'var(--text-primary)' }}>
              "{preview.tier1.text}"
            </p>
          </div>

          {preview.tier2.map((t2, i) => (
            <div key={i} className="entity-card" style={{ marginBottom: 12 }}>
              <h3>Tier 2 #{i + 1}</h3>
              <p style={{ fontSize: 15, fontWeight: 500, marginTop: 4, color: 'var(--text-primary)' }}>
                "{t2.text}"
              </p>
              {t2.tier3.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>Proof bullets:</div>
                  {t2.tier3.map((b, j) => (
                    <span key={j} style={{ fontSize: 13, color: 'var(--text-secondary)', marginRight: 8 }}>• {b}</span>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="step-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>Regenerate</button>
            <button className="btn btn-primary" onClick={applyToTable}>Apply to Three Tier Table</button>
          </div>
        </div>
      )}

      {applied && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h3>Statements applied to your Three Tier table</h3>
          <p style={{ marginTop: 8 }}>An "Initial Generation" snapshot has been saved. You can always restore it.</p>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep} disabled={!applied && !draft.tier1Statement}>
          Next: View & Edit Table
        </button>
      </div>
    </div>
  );
}
