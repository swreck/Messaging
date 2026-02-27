import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import { InfoTooltip } from '../../shared/InfoTooltip';
import type { MagicHourResponse } from '../../types';

export function Step8MagicHour({ draft, loadDraft, prevStep }: StepProps) {
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MagicHourResponse | null>(null);

  async function runMagicHour() {
    setRunning(true);
    // Save a pre-magic-hour snapshot
    await api.post(`/versions/table/${draft.id}`, { label: 'Pre-Magic Hour' });

    try {
      const r = await api.post<MagicHourResponse>('/ai/magic-hour', { draftId: draft.id });
      setResult(r);
    } catch (err: any) {
      alert(`Magic Hour failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  }

  async function applySuggestion(cell: string, suggested: string) {
    // Parse cell reference
    if (cell === 'tier1') {
      await api.put(`/tiers/${draft.id}/tier1`, { text: suggested, changeSource: 'magic_hour' });
    } else if (cell.startsWith('tier2-')) {
      const idx = parseInt(cell.replace('tier2-', ''), 10);
      const t2 = draft.tier2Statements[idx];
      if (t2) await api.put(`/tiers/${draft.id}/tier2/${t2.id}`, { text: suggested, changeSource: 'magic_hour' });
    } else if (cell.startsWith('tier3-')) {
      const parts = cell.replace('tier3-', '').split('-');
      const t2Idx = parseInt(parts[0], 10);
      const t3Idx = parseInt(parts[1], 10);
      const t3 = draft.tier2Statements[t2Idx]?.tier3Bullets[t3Idx];
      if (t3) await api.put(`/tiers/${draft.id}/tier3/${t3.id}`, { text: suggested, changeSource: 'magic_hour' });
    }
    await loadDraft();
    // Remove applied suggestion
    setResult(prev => prev ? {
      ...prev,
      suggestions: prev.suggestions.filter(s => !(s.cell === cell && s.suggested === suggested)),
    } : prev);
  }

  async function markComplete() {
    await api.patch(`/drafts/${draft.id}`, { status: 'completed' });
    await api.post(`/versions/table/${draft.id}`, { label: 'Final Version' });
  }

  return (
    <div className="step-panel" style={{ maxWidth: 1100 }}>
      <h2>
        Step 8: Magic Hour
        <InfoTooltip text="One final review pass. Maria will suggest targeted improvements — accept or dismiss each one. Then save your final version." />
      </h2>
      <p className="step-description">
        This is your final polish pass. Maria will review the entire table and suggest targeted improvements. You choose which to accept.
      </p>

      <ThreeTierTable draft={draft} onUpdate={loadDraft} />

      <div style={{ marginTop: 16 }}>
        {!result && (
          <button className="btn btn-primary" onClick={runMagicHour} disabled={running}>
            {running ? <><Spinner size={14} /> Running Magic Hour...</> : 'Run Magic Hour Review'}
          </button>
        )}

        {result && (
          <div className="audit-panel">
            <h3>Magic Hour Suggestions</h3>
            <p style={{ marginBottom: 16, color: 'var(--text-secondary)' }}>{result.overallNote}</p>

            {result.suggestions.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--success)' }}>No suggestions — your message looks great!</p>
            ) : (
              result.suggestions.map((s, i) => (
                <div key={i} className="audit-issue medium" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>{s.cell}</div>
                    <div style={{ fontSize: 13, textDecoration: 'line-through', color: 'var(--text-tertiary)' }}>{s.current}</div>
                    <div style={{ fontSize: 14, fontWeight: 500, marginTop: 2 }}>{s.suggested}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{s.reason}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => applySuggestion(s.cell, s.suggested)} style={{ color: 'var(--success)' }}>Accept</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setResult(prev => prev ? { ...prev, suggestions: prev.suggestions.filter((_, j) => j !== i) } : prev)}>Dismiss</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back to Table</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={async () => { await markComplete(); navigate(`/five-chapter/${draft.id}`); }}>
            Generate Five Chapter Story
          </button>
          <button className="btn btn-primary" onClick={async () => { await markComplete(); navigate('/'); }}>
            Done — Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
