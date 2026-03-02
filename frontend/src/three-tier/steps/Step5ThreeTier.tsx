import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import type { TableVersion, ReviewResponse, DirectionResponse, TableSnapshot } from '../../types';

export function Step5ThreeTier({ draft, loadDraft, refreshDraft, prevStep, goToStep }: StepProps) {
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<Map<string, string>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [refining, setRefining] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [hasEdited, setHasEdited] = useState(false);

  // Direction
  const [directionText, setDirectionText] = useState('');
  const [sendingDirection, setSendingDirection] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Snapshot of table state for "revise from edits"
  const previousStateRef = useRef<TableSnapshot | null>(null);

  // Capture current table state as a snapshot
  const captureState = useCallback((): TableSnapshot => ({
    tier1: draft.tier1Statement?.text || '',
    tier2: draft.tier2Statements.map(t2 => ({
      text: t2.text,
      tier3: t2.tier3Bullets.map(t3 => t3.text),
    })),
  }), [draft]);

  // Snapshot when there are no active suggestions (baseline for "revise from edits")
  if (suggestions.size === 0 && !previousStateRef.current) {
    previousStateRef.current = captureState();
  }

  async function askMaria() {
    setReviewing(true);
    try {
      const result = await api.post<ReviewResponse>('/ai/review', { draftId: draft.id });
      const map = new Map<string, string>();
      for (const s of result.suggestions || []) {
        map.set(s.cell, s.suggested);
      }
      setSuggestions(map);
      previousStateRef.current = captureState();
    } catch (err: any) {
      alert(`Review failed: ${err.message}`);
    } finally {
      setReviewing(false);
    }
  }

  async function reviseFromEdits() {
    if (!previousStateRef.current) return;
    setRevising(true);
    try {
      const result = await api.post<ReviewResponse>('/ai/revise', {
        draftId: draft.id,
        previousState: previousStateRef.current,
      });
      const map = new Map<string, string>();
      for (const s of result.suggestions || []) {
        map.set(s.cell, s.suggested);
      }
      setSuggestions(map);
      previousStateRef.current = captureState();
      setHasEdited(false);
    } catch (err: any) {
      alert(`Revise failed: ${err.message}`);
    } finally {
      setRevising(false);
    }
  }

  async function refineLanguage() {
    setRefining(true);
    try {
      const result = await api.post<{
        refinedTier2: { index: number; text: string }[];
      }>('/ai/refine-language', { draftId: draft.id });
      const map = new Map<string, string>();
      for (const item of result.refinedTier2 || []) {
        map.set(`tier2-${item.index}`, item.text);
      }
      setSuggestions(map);
      previousStateRef.current = captureState();
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
      const result = await api.post<DirectionResponse>('/ai/direction', {
        draftId: draft.id,
        direction: directionText.trim(),
      });
      const map = new Map<string, string>();
      for (const s of result.suggestions || []) {
        map.set(s.cell, s.suggested);
      }
      setSuggestions(map);
      setDirectionText('');
      previousStateRef.current = captureState();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally {
      setSendingDirection(false);
    }
  }

  async function handleAcceptSuggestion(cell: string, text: string) {
    try {
      if (cell === 'tier1') {
        await api.put(`/tiers/${draft.id}/tier1`, { text, changeSource: 'review' });
      } else if (cell.startsWith('tier2-')) {
        const index = parseInt(cell.split('-')[1]);
        const t2 = draft.tier2Statements[index];
        if (t2) {
          await api.put(`/tiers/${draft.id}/tier2/${t2.id}`, { text, changeSource: 'review' });
        }
      } else if (cell.startsWith('tier3-')) {
        const parts = cell.split('-');
        const t2Index = parseInt(parts[1]);
        const t3Index = parseInt(parts[2]);
        const t2 = draft.tier2Statements[t2Index];
        if (t2 && t2.tier3Bullets[t3Index]) {
          await api.put(`/tiers/${draft.id}/tier3/${t2.tier3Bullets[t3Index].id}`, { text, changeSource: 'review' });
        }
      }
      setSuggestions(prev => {
        const next = new Map(prev);
        next.delete(cell);
        if (next.size === 0) previousStateRef.current = null;
        return next;
      });
      await refreshDraft();
    } catch (err: any) {
      alert(`Failed to apply: ${err.message}`);
    }
  }

  function handleDismissSuggestion(cell: string) {
    setSuggestions(prev => {
      const next = new Map(prev);
      next.delete(cell);
      if (next.size === 0) previousStateRef.current = null;
      return next;
    });
  }

  function clearSuggestions() {
    setSuggestions(new Map());
    previousStateRef.current = null;
  }

  function handleTableUpdate() {
    previousStateRef.current = null;
    setHasEdited(true);
    refreshDraft();
  }

  async function regenerate() {
    if (!confirm('Start over? Maria will save a snapshot of your current table, then regenerate from scratch.')) return;
    setRegenerating(true);
    try {
      await api.post(`/tiers/${draft.id}/reset`);
      await loadDraft();
      goToStep(4);
    } catch (err: any) {
      alert(`Regenerate failed: ${err.message}`);
      setRegenerating(false);
    }
  }

  async function createSnapshot() {
    await api.post(`/versions/table/${draft.id}`, { label: snapshotLabel || undefined });
    setSnapshotLabel('');
    await refreshDraft();
  }

  async function restoreSnapshot(versionId: string) {
    if (!confirm('Restore this snapshot? Current table will be replaced.')) return;
    await api.post(`/versions/table/${draft.id}/restore/${versionId}`);
    await loadDraft();
    clearSuggestions();
  }

  const anyBusy = reviewing || revising || refining || sendingDirection || regenerating;

  return (
    <div className="step-panel" style={{ maxWidth: 1100 }}>
      <h2>Your Three Tier</h2>
      <p className="step-description">
        Click any cell to edit. Use the tools below to have Maria suggest improvements.
      </p>

      {/* Direction input */}
      <div className="direction-input" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={directionText}
            onChange={e => setDirectionText(e.target.value)}
            placeholder="Tell Maria what you'd like changed... e.g. 'Make the whole thing more focused on cost savings'"
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
        <button className="btn btn-secondary btn-sm" onClick={askMaria} disabled={anyBusy}>
          {reviewing ? <><Spinner size={12} /> Reviewing...</> : 'Ask Maria'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={refineLanguage} disabled={anyBusy}>
          {refining ? <><Spinner size={12} /> Refining...</> : 'Refine Language'}
        </button>
        {draft.mappings.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => window.open(`/mapping/${draft.id}`, '_blank')}>
            Show mapping
          </button>
        )}
        {hasEdited && (
          <button className="btn btn-secondary btn-sm" onClick={reviseFromEdits} disabled={anyBusy}>
            {revising ? <><Spinner size={12} /> Revising...</> : 'Learn from my edits & revise'}
          </button>
        )}
        {suggestions.size > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={clearSuggestions}>
            Clear suggestions
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-danger" onClick={regenerate} disabled={anyBusy}>
          {regenerating ? <><Spinner size={12} /> Regenerating...</> : 'Regenerate'}
        </button>
      </div>

      <ThreeTierTable
        draft={draft}
        onUpdate={handleTableUpdate}
        suggestions={suggestions}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={handleDismissSuggestion}
      />

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
