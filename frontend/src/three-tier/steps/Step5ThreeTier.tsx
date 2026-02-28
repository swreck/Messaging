import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import type { TableVersion } from '../../types';

interface Suggestion {
  cell: string;
  current: string;
  suggested: string;
  reason: string;
}

export function Step5ThreeTier({ draft, loadDraft, prevStep }: StepProps) {
  const navigate = useNavigate();
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<any>(null);
  const [refining, setRefining] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');

  // Direction
  const [directionText, setDirectionText] = useState('');
  const [sendingDirection, setSendingDirection] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [directionNote, setDirectionNote] = useState('');
  const [expandedSuggestion, setExpandedSuggestion] = useState<number | null>(null);

  async function runAudit() {
    setAuditing(true);
    try {
      const result = await api.post<any>('/ai/audit', { draftId: draft.id });
      setAuditResult(result);
    } catch (err: any) {
      alert(`Review failed: ${err.message}`);
    } finally {
      setAuditing(false);
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
      alert(`Refine failed: ${err.message}`);
    } finally {
      setRefining(false);
    }
  }

  async function sendDirection() {
    if (!directionText.trim()) return;
    setSendingDirection(true);
    try {
      const result = await api.post<{ suggestions: Suggestion[]; overallNote: string }>('/ai/direction', {
        draftId: draft.id,
        direction: directionText.trim(),
      });
      setSuggestions(result.suggestions || []);
      setDirectionNote(result.overallNote || '');
      setDirectionText('');
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally {
      setSendingDirection(false);
    }
  }

  async function applySuggestion(suggestion: Suggestion) {
    try {
      // Parse the cell reference to determine what to update
      if (suggestion.cell === 'tier1') {
        await api.put(`/tiers/${draft.id}/tier1`, { text: suggestion.suggested, changeSource: 'direction' });
      } else if (suggestion.cell.startsWith('tier2-')) {
        const index = parseInt(suggestion.cell.split('-')[1]);
        const t2 = draft.tier2Statements[index];
        if (t2) {
          await api.put(`/tiers/${draft.id}/tier2/${t2.id}`, { text: suggestion.suggested, changeSource: 'direction' });
        }
      } else if (suggestion.cell.startsWith('tier3-')) {
        const parts = suggestion.cell.split('-');
        const t2Index = parseInt(parts[1]);
        const t3Index = parseInt(parts[2]);
        const t2 = draft.tier2Statements[t2Index];
        if (t2 && t2.tier3Bullets[t3Index]) {
          await api.put(`/tiers/${draft.id}/tier3/${t2.tier3Bullets[t3Index].id}`, { text: suggestion.suggested, changeSource: 'direction' });
        }
      }
      // Remove the applied suggestion
      setSuggestions(prev => prev.filter(s => s !== suggestion));
      await loadDraft();
    } catch (err: any) {
      alert(`Failed to apply: ${err.message}`);
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
      <h2>Your Three Tier</h2>
      <p className="step-description">
        Click any cell to edit. Use the tools below to have Maria review or refine the language.
      </p>

      {/* Direction input */}
      <div className="direction-input" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={directionText}
            onChange={e => setDirectionText(e.target.value)}
            placeholder="Tell Maria what you'd like changed... e.g. 'Make the whole thing more focused on cost savings' or 'Reorder to lead with security'"
            style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 14,
              minHeight: 44,
              maxHeight: 120,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendDirection();
              }
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={sendDirection}
            disabled={sendingDirection || !directionText.trim()}
            style={{ minWidth: 80, height: 44 }}
          >
            {sendingDirection ? <Spinner size={14} /> : 'Send'}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="three-tier-toolbar">
        <button className="btn btn-secondary btn-sm" onClick={runAudit} disabled={auditing}>
          {auditing ? <><Spinner size={12} /> Reviewing...</> : 'Ask Maria to Review'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={runRefineLanguage} disabled={refining}>
          {refining ? <><Spinner size={12} /> Refining...</> : 'Refine Language'}
        </button>
      </div>

      {/* Maria's direction suggestions */}
      {(suggestions.length > 0 || directionNote) && (
        <div className="direction-suggestions" style={{
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius)',
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Maria's Suggestions</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSuggestions([]); setDirectionNote(''); }}>&times;</button>
          </div>
          {directionNote && (
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>{directionNote}</p>
          )}
          {suggestions.map((s, i) => (
            <div key={i} className="suggestion-card" style={{
              background: 'var(--bg)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-sm)',
              padding: 12,
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase' }}>{s.cell}</span>
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)' }}>{s.current}</span>
                    <span style={{ margin: '0 6px', color: 'var(--text-tertiary)' }}>&rarr;</span>
                    <span style={{ fontWeight: 500 }}>{s.suggested}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpandedSuggestion(expandedSuggestion === i ? null : i)}
                    title="Why?"
                    style={{ padding: '2px 6px', fontSize: 12 }}
                  >
                    i
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => applySuggestion(s)}
                    style={{ padding: '2px 8px', fontSize: 12 }}
                  >
                    Apply
                  </button>
                </div>
              </div>
              {expandedSuggestion === i && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-light)' }}>
                  {s.reason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ThreeTierTable draft={draft} onUpdate={loadDraft} />

      {/* Audit Results */}
      {auditResult && (
        <div className="audit-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Maria's Review</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setAuditResult(null)}>&times;</button>
          </div>
          <div className="audit-score">{auditResult.overallScore}/100</div>
          <p style={{ textAlign: 'center', marginBottom: 16 }}>{auditResult.summary}</p>
          {auditResult.issues?.map((issue: any, i: number) => (
            <div key={i} className={`audit-issue ${issue.severity}`}>
              <strong>{issue.cell}</strong>: {issue.issue}
              {issue.suggestion && <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>Suggestion: {issue.suggestion}</div>}
            </div>
          ))}
          {auditResult.strengths?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong>Strengths:</strong>
              <ul style={{ paddingLeft: 20, marginTop: 4 }}>
                {auditResult.strengths.map((s: string, i: number) => <li key={i} style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Table Version Panel */}
      <div className="table-version-panel">
        <div className="table-version-header" onClick={() => setVersionsOpen(!versionsOpen)}>
          <span>Snapshots ({draft.tableVersions?.length || 0})</span>
          <span>{versionsOpen ? '\u25B2' : '\u25BC'}</span>
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => navigate('/')}>Dashboard</button>
          <button className="btn btn-primary" onClick={() => navigate(`/five-chapter/${draft.id}`)}>
            Create New Deliverable
          </button>
        </div>
      </div>
    </div>
  );
}
