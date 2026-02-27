import { useState } from 'react';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import { InfoTooltip } from '../../shared/InfoTooltip';
import type { AuditResponse, TableVersion } from '../../types';

export function Step7ThreeTierTable({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [poetryPassing, setPoetryPassing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');

  async function runAudit() {
    setAuditing(true);
    try {
      const result = await api.post<AuditResponse>('/ai/audit', { draftId: draft.id });
      setAudit(result);
    } catch (err: any) {
      alert(`Audit failed: ${err.message}`);
    } finally {
      setAuditing(false);
    }
  }

  async function runPoetryPass() {
    setPoetryPassing(true);
    try {
      const result = await api.post<{ tier1: { text: string }; tier2: { text: string; tier3: string[] }[] }>('/ai/poetry-pass', { draftId: draft.id });

      // Apply the refined text
      if (result.tier1?.text) {
        await api.put(`/tiers/${draft.id}/tier1`, { text: result.tier1.text, changeSource: 'poetry_pass' });
      }
      if (result.tier2) {
        for (let i = 0; i < result.tier2.length && i < draft.tier2Statements.length; i++) {
          await api.put(`/tiers/${draft.id}/tier2/${draft.tier2Statements[i].id}`, { text: result.tier2[i].text, changeSource: 'poetry_pass' });
          if (result.tier2[i].tier3) {
            await api.post(`/tiers/${draft.id}/tier2/${draft.tier2Statements[i].id}/tier3/bulk`, {
              bullets: result.tier2[i].tier3,
              changeSource: 'poetry_pass',
            });
          }
        }
      }
      await loadDraft();
    } catch (err: any) {
      alert(`Poetry Pass failed: ${err.message}`);
    } finally {
      setPoetryPassing(false);
    }
  }

  async function runRefineLanguage() {
    setRefining(true);
    try {
      const result = await api.post<{ tier2: { text: string; priorityId: string }[] }>('/ai/refine-language', { draftId: draft.id });

      if (result.tier2) {
        await api.post(`/tiers/${draft.id}/tier2/bulk`, {
          statements: result.tier2,
          changeSource: 'refine',
        });
      }
      await loadDraft();
    } catch (err: any) {
      alert(`Refine Language failed: ${err.message}`);
    } finally {
      setRefining(false);
    }
  }

  async function createSnapshot() {
    await api.post(`/versions/table/${draft.id}`, { label: snapshotLabel || undefined });
    setSnapshotLabel('');
    await loadDraft();
  }

  async function restoreSnapshot(versionId: string) {
    if (!confirm('Restore this snapshot? Current table will be replaced.')) return;
    await api.post(`/versions/table/${draft.id}/restore/${versionId}`);
    await loadDraft();
  }

  return (
    <div className="step-panel" style={{ maxWidth: 1100 }}>
      <h2>
        Step 7: Your Three Tier Table
        <InfoTooltip text="Click any cell to edit. Use the toolbar to run AI passes. Every edit is tracked — use the version arrows to go back." />
      </h2>

      {/* Toolbar */}
      <div className="three-tier-toolbar">
        <button className="btn btn-secondary btn-sm" onClick={runAudit} disabled={auditing}>
          {auditing ? <><Spinner size={12} /> Auditing...</> : 'Audit'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={runPoetryPass} disabled={poetryPassing}>
          {poetryPassing ? <><Spinner size={12} /> Polishing...</> : 'Poetry Pass'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={runRefineLanguage} disabled={refining}>
          {refining ? <><Spinner size={12} /> Refining...</> : 'Refine Language'}
        </button>
      </div>

      <ThreeTierTable draft={draft} onUpdate={loadDraft} />

      {/* Audit Results */}
      {audit && (
        <div className="audit-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Audit Results</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setAudit(null)}>&times;</button>
          </div>
          <div className="audit-score">{audit.overallScore}/100</div>
          <p style={{ textAlign: 'center', marginBottom: 16 }}>{audit.summary}</p>
          {audit.issues.map((issue, i) => (
            <div key={i} className={`audit-issue ${issue.severity}`}>
              <strong>{issue.cell}</strong>: {issue.issue}
              {issue.suggestion && <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>Suggestion: {issue.suggestion}</div>}
            </div>
          ))}
          {audit.strengths.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong>Strengths:</strong>
              <ul style={{ paddingLeft: 20, marginTop: 4 }}>
                {audit.strengths.map((s, i) => <li key={i} style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Table Version Panel */}
      <div className="table-version-panel">
        <div className="table-version-header" onClick={() => setVersionsOpen(!versionsOpen)}>
          <span>Table Snapshots ({draft.tableVersions?.length || 0})</span>
          <span>{versionsOpen ? '▲' : '▼'}</span>
        </div>
        {versionsOpen && (
          <div className="table-version-list">
            <div style={{ padding: '8px 16px', display: 'flex', gap: 8 }}>
              <input
                value={snapshotLabel}
                onChange={e => setSnapshotLabel(e.target.value)}
                placeholder="Snapshot label (optional)"
                style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}
              />
              <button className="btn btn-secondary btn-sm" onClick={createSnapshot}>Save Snapshot</button>
            </div>
            {(draft.tableVersions || []).map((v: TableVersion) => (
              <div key={v.id} className="table-version-item">
                <div>
                  <strong>{v.label}</strong>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginLeft: 8 }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => restoreSnapshot(v.id)}>Restore</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep}>
          Next: Magic Hour
        </button>
      </div>
    </div>
  );
}
