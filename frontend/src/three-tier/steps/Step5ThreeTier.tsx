import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import { InfoTooltip } from '../../shared/InfoTooltip';
import { CompareModal } from '../components/CompareModal';
import { Modal } from '../../shared/Modal';
import type { TableVersion, ReviewResponse, DirectionResponse, TableSnapshot } from '../../types';


export function Step5ThreeTier({ draft, loadDraft, refreshDraft, prevStep, goToStep }: StepProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Map<string, string>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [refining, setRefining] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [hasEdited, setHasEdited] = useState(false);
  const [hasRefined, setHasRefined] = useState(false);
  const [showRefineNudge, setShowRefineNudge] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  // Direction
  const [directionText, setDirectionText] = useState('');
  const [sendingDirection, setSendingDirection] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [polishing, setPolishing] = useState(false);

  // Cell focus — for scoped directions and glow
  const [focusedCell, setFocusedCell] = useState<string | null>(null);

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (isNaN(diff)) return 'recently';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // More tools dropdown
  const [showMoreTools, setShowMoreTools] = useState(false);
  const moreToolsRef = useRef<HTMLDivElement>(null);

  // Close "..." menu on outside click
  useEffect(() => {
    if (!showMoreTools) return;
    function handleClick(e: MouseEvent) {
      if (moreToolsRef.current && !moreToolsRef.current.contains(e.target as Node)) {
        setShowMoreTools(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMoreTools]);

  // Compare modal
  const [compareSnapshot, setCompareSnapshot] = useState<{ snapshot: any; label: string } | null>(null);

  // Restore confirmation
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

  // Step 5 orientation — show once per draft
  const orientationKey = `step5-oriented-${draft.id}`;
  const [showOrientation, setShowOrientation] = useState(() => {
    return !localStorage.getItem(orientationKey);
  });

  function dismissOrientation() {
    localStorage.setItem(orientationKey, '1');
    setShowOrientation(false);
  }

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
    setError(null);
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
      setError('Something went wrong. Please try again.');
    } finally {
      setReviewing(false);
    }
  }

  async function reviseFromEdits() {
    if (!previousStateRef.current) return;
    setError(null);
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
      setError('Something went wrong. Please try again.');
    } finally {
      setRevising(false);
    }
  }

  // Tier 1 alternative from Refine Language
  const [tier1Alternative, setTier1Alternative] = useState<string | null>(null);

  async function refineLanguage() {
    setError(null);
    setRefining(true);
    setTier1Alternative(null);
    try {
      const result = await api.post<{
        refinedTier1?: { best: string; alternative: string };
        refinedTier2: { index: number; text: string }[];
      }>('/ai/refine-language', { draftId: draft.id });
      const map = new Map<string, string>();
      // Tier 1: Maria's pick goes in suggestions, alternative stored separately
      if (result.refinedTier1) {
        map.set('tier1', result.refinedTier1.best);
        setTier1Alternative(result.refinedTier1.alternative);
      }
      for (const item of result.refinedTier2 || []) {
        map.set(`tier2-${item.index}`, item.text);
      }
      setSuggestions(map);
      previousStateRef.current = captureState();
      setHasRefined(true);
    } catch (err: any) {
      setError('Something went wrong. Please try again.');
    } finally {
      setRefining(false);
    }
  }

  async function polish() {
    setError(null);
    setPolishing(true);
    try {
      const result = await api.post<{
        suggestions: { cell: string; suggested: string }[];
      }>('/ai/polish', { draftId: draft.id });
      const map = new Map<string, string>();
      for (const s of result.suggestions || []) {
        map.set(s.cell, s.suggested);
      }
      setSuggestions(map);
      previousStateRef.current = captureState();
    } catch (err: any) {
      setError('Something went wrong. Please try again.');
    } finally {
      setPolishing(false);
    }
  }

  async function sendDirection() {
    if (!directionText.trim()) return;
    setError(null);
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
      setError('Something went wrong. Please try again.');
    } finally {
      setSendingDirection(false);
    }
  }

  async function handleAcceptSuggestion(cell: string, text: string) {
    try {
      if (cell === 'tier1') {
        await api.put(`/tiers/${draft.id}/tier1`, { text, changeSource: 'review', version: draft.version });
      } else if (cell.startsWith('tier2-')) {
        const index = parseInt(cell.split('-')[1]);
        const t2 = draft.tier2Statements[index];
        if (t2) {
          await api.put(`/tiers/${draft.id}/tier2/${t2.id}`, { text, changeSource: 'review', version: draft.version });
        }
      } else if (cell.match(/^tier3-\d+-add$/)) {
        // Add new Tier 3 bullet
        const t2Index = parseInt(cell.split('-')[1]);
        const t2 = draft.tier2Statements[t2Index];
        if (t2) {
          await api.post(`/tiers/${draft.id}/tier2/${t2.id}/tier3`, { text, changeSource: 'review' });
        }
      } else if (cell.startsWith('tier3-')) {
        const parts = cell.split('-');
        const t2Index = parseInt(parts[1]);
        const t3Index = parseInt(parts[2]);
        const t2 = draft.tier2Statements[t2Index];
        if (t2 && t2.tier3Bullets[t3Index]) {
          await api.put(`/tiers/${draft.id}/tier3/${t2.tier3Bullets[t3Index].id}`, { text, changeSource: 'review', version: draft.version });
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
      if (err?.status === 409) {
        handleConflict();
      } else {
        setError('Something went wrong. Please try again.');
      }
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

  function handleConflict() {
    setError('This content was edited elsewhere. Refreshing to show the latest version...');
    loadDraft();
  }

  function handleTableUpdate() {
    previousStateRef.current = null;
    setHasEdited(true);
    refreshDraft().then(() => {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 1500);
    });
  }

  async function regenerate() {
    if (!confirm('Start over? Maria will save a snapshot of your current table, then regenerate from scratch.')) return;
    setRegenerating(true);
    try {
      await api.post(`/tiers/${draft.id}/reset`);
      await loadDraft();
      goToStep(4);
    } catch (err: any) {
      setError('Something went wrong. Please try again.');
      setRegenerating(false);
    }
  }

  const [showCheckpointSaved, setShowCheckpointSaved] = useState(false);

  async function createSnapshot() {
    await api.post(`/versions/table/${draft.id}`, { label: snapshotLabel || undefined });
    setSnapshotLabel('');
    setShowCheckpointSaved(true);
    setTimeout(() => setShowCheckpointSaved(false), 2000);
    await refreshDraft();
  }

  async function restoreSnapshot(versionId: string) {
    await api.post(`/versions/table/${draft.id}/restore/${versionId}`);
    await loadDraft();
    clearSuggestions();
    setRestoreTarget(null);
  }

  const anyBusy = reviewing || revising || refining || sendingDirection || regenerating || polishing;

  // Keyboard shortcuts now handled globally in MariaPartner

  return (
    <div className="step-panel" style={{ maxWidth: 1400 }}>
      {error && (
        <div style={{
          padding: '10px 16px',
          marginBottom: 12,
          background: 'var(--error-bg, #fef2f2)',
          color: 'var(--error-text, #991b1b)',
          border: '1px solid var(--error-border, #fecaca)',
          borderRadius: 'var(--radius-sm, 6px)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 14,
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--error-text, #991b1b)',
              padding: '0 4px',
            }}
          >
            &times;
          </button>
        </div>
      )}
      {suggestions.size > 0 && (
        <div className="suggestion-banner">
          <span>I'd adjust {suggestions.size} cell{suggestions.size !== 1 ? 's' : ''}. Take a look?</span>
          <button className="suggestion-banner-dismiss" onClick={() => { setSuggestions(new Map()); setTier1Alternative(null); previousStateRef.current = captureState(); }}>
            Dismiss all
          </button>
        </div>
      )}
      <h2>Your Three Tier</h2>

      {showOrientation && (
        <div className="orientation-card" style={{
          padding: '16px 20px',
          marginBottom: 16,
          background: 'var(--bg-secondary, #f8f8fa)',
          borderRadius: 'var(--radius-md, 10px)',
          border: '1px solid var(--border-light, #e5e5ea)',
          position: 'relative',
        }}>
          <button
            onClick={dismissOrientation}
            aria-label="Dismiss"
            style={{
              position: 'absolute',
              top: 10,
              right: 12,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
              color: 'var(--text-tertiary)',
              padding: '2px 6px',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0, paddingRight: 24 }}>
            Your first draft for {draft.audience.name} — in structural form so you can see the logic. Click anything to edit. <strong>Refine Language</strong> turns it into natural language.
          </p>
        </div>
      )}

      {!showOrientation && (
        <p className="step-description">
          Click any cell to edit. Use the tools below to have Maria suggest improvements.
        </p>
      )}

      {/* Direction input — scope-aware */}
      <div className="direction-input" style={{ marginBottom: 16 }}>
        {focusedCell && (
          <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 4, fontWeight: 500 }}>
            Scoped to {focusedCell.startsWith('tier1') ? 'Tier 1' : focusedCell.startsWith('tier2') ? `Tier 2 column` : 'a proof point'}
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '0 6px', marginLeft: 6 }}
              onClick={() => setFocusedCell(null)}
            >clear</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={directionText}
            onChange={e => setDirectionText(e.target.value)}
            placeholder={hasRefined
              ? "Tell Maria what to change..."
              : "Ready to refine? Or tell Maria what to change first."
            }
            style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 15,
              minHeight: 44,
              maxHeight: 120,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !anyBusy) {
                e.preventDefault();
                sendDirection();
              }
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={sendDirection}
            disabled={anyBusy || !directionText.trim()}
            style={{ minWidth: 80, height: 44 }}
          >
            {sendingDirection ? <Spinner size={14} /> : 'Send'}
          </button>
        </div>
      </div>

      {/* Toolbar — simplified */}
      <div className="three-tier-toolbar">
        <button
          className={`btn btn-sm ${hasRefined ? 'btn-secondary' : 'btn-primary'}`}
          onClick={refineLanguage}
          disabled={anyBusy}
          title="Rewrite statements to sound more natural while keeping the meaning"
        >
          {refining ? <><Spinner size={12} /> Refining...</> : 'Refine Language'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={askMaria} disabled={anyBusy} title="Maria reviews your message and tells you what she'd improve">
          {reviewing ? <><Spinner size={12} /> Reviewing...</> : 'Ask Maria to review'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={polish} disabled={anyBusy} title="Results are usually better, but takes a little longer">
          {polishing ? <><Spinner size={12} /> Polishing...</> : <>Polish <InfoTooltip text="Results are usually better, but takes a little longer." /></>}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={createSnapshot} title="Save the current state as a checkpoint you can return to">
          {showCheckpointSaved ? 'Checkpoint saved' : 'Save checkpoint'}
        </button>
        {hasEdited && (
          <button className="btn btn-secondary btn-sm" onClick={reviseFromEdits} disabled={anyBusy} title="Maria revises other cells to match your edits">
            {revising ? <><Spinner size={12} /> Revising...</> : 'Match the rest to my edits'}
          </button>
        )}
        <div style={{ position: 'relative' }} ref={moreToolsRef}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowMoreTools(!showMoreTools)}>
            &middot;&middot;&middot;
          </button>
          {showMoreTools && (
            <div style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              background: 'var(--bg-card)',
              border: '1px solid #d1d1d6',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-md)',
              zIndex: 20,
              padding: '4px 0',
              minWidth: 180,
            }}>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '8px 14px' }} onClick={() => { setVersionsOpen(true); setShowMoreTools(false); }}>
                View checkpoints ({draft.tableVersions?.length || 0})
              </button>
              {draft.mappings.length > 0 && (
                <button className="btn btn-ghost btn-sm" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '8px 14px' }} onClick={() => { window.open(`/mapping/${draft.id}`, '_blank'); setShowMoreTools(false); }}>
                  Show mapping
                </button>
              )}
              {suggestions.size > 0 && (
                <button className="btn btn-ghost btn-sm" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '8px 14px' }} onClick={() => { clearSuggestions(); setShowMoreTools(false); }}>
                  Clear suggestions
                </button>
              )}
              <button className="btn btn-ghost btn-sm btn-danger" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '8px 14px' }} onClick={() => { regenerate(); setShowMoreTools(false); }} disabled={anyBusy}>
                {regenerating ? 'Regenerating...' : 'Regenerate'}
              </button>
            </div>
          )}
        </div>
      </div>

      <ThreeTierTable
        draft={draft}
        onUpdate={handleTableUpdate}
        onConflict={handleConflict}
        suggestions={suggestions}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={handleDismissSuggestion}
        tier1Alternative={tier1Alternative}
        focusedCell={focusedCell}
        onCellFocus={setFocusedCell}
      />

      {/* Checkpoint slide-out panel */}
      {versionsOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          maxWidth: '100vw',
          background: 'var(--bg-card)',
          borderLeft: '1px solid #d1d1d6',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #d1d1d6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Checkpoints</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setVersionsOpen(false)}>&times;</button>
          </div>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #d1d1d6', display: 'flex', gap: 8 }}>
            <input
              value={snapshotLabel}
              onChange={e => setSnapshotLabel(e.target.value)}
              placeholder="Label (optional)"
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d1d6', borderRadius: 'var(--radius-sm)', fontSize: 14 }}
            />
            <button className="btn btn-secondary btn-sm" onClick={createSnapshot}>Save</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {(draft.tableVersions?.length || 0) === 0 && (
              <p style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-tertiary)', margin: 0 }}>
                No checkpoints yet. Save one before making big changes.
              </p>
            )}
            {(draft.tableVersions || []).map((v: TableVersion) => {
              const timeAgo = formatTimeAgo(v.createdAt);
              return (
                <div key={v.id} style={{ padding: '10px 20px', borderBottom: '1px solid var(--bg-secondary)', cursor: 'default' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 14 }}>{v.label}</strong>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{timeAgo}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setCompareSnapshot({ snapshot: v.snapshot, label: v.label })}>Compare</button>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setRestoreTarget(v.id)}>Restore</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Refine nudge — shows when user tries to move on without refining */}
      {showRefineNudge && (
        <div style={{
          padding: '14px 18px',
          marginBottom: 12,
          background: 'var(--bg-secondary, #f8f8fa)',
          borderRadius: 'var(--radius-sm, 6px)',
          border: '1px solid var(--border-light, #e5e5ea)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Your Three Tier is still in first-draft form. The story will be stronger if you refine the language first.
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-primary btn-sm" onClick={() => { setShowRefineNudge(false); refineLanguage(); }}>
              Refine now
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowRefineNudge(false); navigate(`/five-chapter/${draft.id}`); }}>
              Continue anyway
            </button>
          </div>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => navigate('/')}>Dashboard</button>
          <button className="btn btn-primary" onClick={() => {
            if (!hasRefined && !hasEdited) {
              setShowRefineNudge(true);
            } else {
              navigate(`/five-chapter/${draft.id}`);
            }
          }}>
            Turn Into an Email, Pitch, or Story
          </button>
        </div>
      </div>

      <div className={`save-indicator ${showSaved ? 'visible' : ''}`}>Saved</div>

      {compareSnapshot && (
        <CompareModal
          open={true}
          onClose={() => setCompareSnapshot(null)}
          snapshot={compareSnapshot.snapshot}
          current={captureState()}
          snapshotLabel={compareSnapshot.label}
        />
      )}

      <Modal open={!!restoreTarget} onClose={() => setRestoreTarget(null)} title="Restore snapshot?">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', marginBottom: 20 }}>
          Your current table will be replaced with this snapshot. A backup of your current version will be saved automatically.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setRestoreTarget(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => restoreTarget && restoreSnapshot(restoreTarget)}>Restore</button>
        </div>
      </Modal>
    </div>
  );
}
