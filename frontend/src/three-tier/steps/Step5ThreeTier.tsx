import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StepProps } from './types';
import { api } from '../../api/client';
import { ThreeTierTable, type ReviewViewMode, type CellMarkupState } from '../components/ThreeTierTable';
import { Spinner } from '../../shared/Spinner';
import { RotatingPhrases } from '../../shared/RotatingPhrases';
import { CompareModal } from '../components/CompareModal';
import { Modal } from '../../shared/Modal';
import { ConfirmModal } from '../../shared/ConfirmModal';
import type { TableVersion, ReviewResponse, DirectionResponse, TableSnapshot } from '../../types';

// Frontend voice-guard patterns — mirrors backend/src/lib/voiceGuard.ts.
// Kept in sync with that file; both enforce Ken's Voice Rule 5 contrast clauses
// and Rule 10 word count. Banner surfaces stored drafts whose statements predate
// the voice guard and still carry old-style voice violations.
const CONTRAST_CLAUSE_PATTERNS: RegExp[] = [
  /\bwithout\s+\w+ing\b/i,
  /\bwithout\s+(?:the\s+|any\s+|a\s+)?(?:risk|hassle|cost|tradeoff|compromise|downside|overhead|delay|loss|sacrifice)\b/i,
  /\binstead\s+of\b/i,
  /\brather\s+than\b/i,
  /\bno\s+tradeoff/i,
  /\bnot\s+just\b/i,
];
function statementHasVoiceViolation(text: string | null | undefined, maxWords = 20): boolean {
  if (!text || !text.trim()) return false;
  const [mainRaw] = text.split(/\bbecause\b/i);
  const main = (mainRaw || text).trim();
  for (const p of CONTRAST_CLAUSE_PATTERNS) if (p.test(main)) return true;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words > maxWords;
}


export function Step5ThreeTier({ draft, loadDraft, refreshDraft, prevStep, goToStep }: StepProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Map<string, string>>(new Map());

  // Round A1 — Three-view-mode pattern. Persists per-user (not per-draft) so the
  // user's preference carries from one foundation to the next. State of
  // observations is server-side; viewMode is purely a frontend visibility setting.
  const VIEW_MODE_KEY = 'three-tier-view-mode';
  const [viewMode, setViewModeState] = useState<ReviewViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === 'no-markup' || saved === 'minimal' || saved === 'all-markup') return saved;
    } catch {}
    return 'minimal';
  });
  function setViewMode(next: ReviewViewMode) {
    setViewModeState(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch {}
  }

  // Per-cell markup state. Populated alongside `suggestions` whenever observations
  // load. Contains an entry for every observation (open AND resolved) when
  // viewMode='all-markup'; only OPEN entries otherwise.
  const [cellStates, setCellStates] = useState<Map<string, CellMarkupState>>(new Map());
  // Round 3.1 Item A — cellKey → Observation.id for OPEN observations so
  // the "Fill this in" submit can resolve the right row server-side.
  const [cellObservationIds, setCellObservationIds] = useState<Map<string, string>>(new Map());

  // Helper — convert an observation row to a UI cell key (tier1, tier2-i, tier3-i-j).
  function observationToCellKey(obs: { cellType: string; cellId: string }): string | null {
    if (obs.cellType === 'tier1') return 'tier1';
    if (obs.cellType === 'tier2') {
      const idx = draft.tier2Statements.findIndex(t2 => t2.id === obs.cellId);
      return idx >= 0 ? `tier2-${idx}` : null;
    }
    if (obs.cellType === 'tier3') {
      const [t2Id, bulletIdxStr] = obs.cellId.split(':');
      const t2Idx = draft.tier2Statements.findIndex(t2 => t2.id === t2Id);
      if (t2Idx < 0) return null;
      const bIdx = parseInt(bulletIdxStr);
      return Number.isNaN(bIdx) ? null : `tier3-${t2Idx}-${bIdx}`;
    }
    return null;
  }

  // Load Maria's observations for this draft on mount and whenever viewMode
  // changes between minimal and all-markup (which controls whether we fetch
  // resolved observations too).
  useEffect(() => {
    if (!draft?.id) return;
    const path = viewMode === 'all-markup'
      ? `/ai/observations/${draft.id}?includeResolved=true`
      : `/ai/observations/${draft.id}`;
    api.get<{ observations: Array<{ id: string; cellType: string; cellId: string; suggestion: string; state?: string }> }>(path)
      .then(({ observations }) => {
        if (!observations || observations.length === 0) {
          setCellStates(new Map());
          setCellObservationIds(new Map());
          return;
        }
        const openMap = new Map<string, string>();
        const stateMap = new Map<string, CellMarkupState>();
        // Round 3.1 Item A — track observation id per cell so the
        // "Fill this in" submit can resolve the right Observation row.
        const idMap = new Map<string, string>();
        for (const obs of observations) {
          const key = observationToCellKey(obs);
          if (!key) continue;
          const state = obs.state || 'OPEN';
          if (state === 'OPEN') {
            openMap.set(key, obs.suggestion);
            stateMap.set(key, 'open');
            idMap.set(key, obs.id);
          } else if (state === 'RESOLVED_BY_CHANGE') {
            stateMap.set(key, 'resolved-change');
          } else if (state === 'RESOLVED_BY_ACKNOWLEDGE') {
            stateMap.set(key, 'resolved-ack');
          }
        }
        // Merge open observations into suggestions; preserve any in-flight
        // suggestions the user hasn't seen yet.
        if (openMap.size > 0) {
          setSuggestions(prev => {
            const merged = new Map(prev);
            for (const [k, v] of openMap) {
              if (!merged.has(k)) merged.set(k, v);
            }
            return merged;
          });
        }
        setCellStates(stateMap);
        setCellObservationIds(idMap);
      })
      .catch(() => {/* non-fatal */});
  }, [draft?.id, viewMode]);

  // Brad-impact tooltip — first-encounter orientation for the new view-mode UX.
  // Replaces the implicit Dismiss-all-as-clear behavior; explains that markup
  // is hidden, not dropped. Persisted per-user so it never re-fires.
  const VIEW_MODE_ORIENTATION_KEY = 'three-tier-view-mode-oriented';
  const [showViewModeOrientation, setShowViewModeOrientation] = useState(() => {
    try { return !localStorage.getItem(VIEW_MODE_ORIENTATION_KEY); } catch { return false; }
  });
  function dismissViewModeOrientation() {
    try { localStorage.setItem(VIEW_MODE_ORIENTATION_KEY, '1'); } catch {}
    setShowViewModeOrientation(false);
  }

  // Maria-equivalent path — switch view mode via chat command. MariaPartner
  // dispatches `three-tier-view-mode` with the requested mode after stripping
  // the `[SET_VIEW_MODE:...]` marker from her response.
  useEffect(() => {
    function handleViewModeEvent(e: Event) {
      const detail = (e as CustomEvent).detail as { mode?: ReviewViewMode } | undefined;
      const mode = detail?.mode;
      if (mode === 'no-markup' || mode === 'minimal' || mode === 'all-markup') {
        setViewMode(mode);
      }
    }
    document.addEventListener('three-tier-view-mode', handleViewModeEvent as EventListener);
    return () => document.removeEventListener('three-tier-view-mode', handleViewModeEvent as EventListener);
  }, []);
  const [reviewing, setReviewing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [refining, setRefining] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
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

  // Regenerate confirmation
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  // Step 5 orientation — show once per draft
  const orientationKey = `step5-oriented-${draft.id}`;
  const [showOrientation, setShowOrientation] = useState(() => {
    return !localStorage.getItem(orientationKey);
  });

  function dismissOrientation() {
    localStorage.setItem(orientationKey, '1');
    setShowOrientation(false);
  }

  // Voice-violation banner — for stored drafts that predate the voice guard
  // and still carry old-style contrast-clause / word-count violations.
  const voiceBannerDismissedKey = `step5-voice-dismissed-${draft.id}`;
  const [voiceBannerDismissed, setVoiceBannerDismissed] = useState(() => {
    return !!localStorage.getItem(voiceBannerDismissedKey);
  });
  const voiceViolationCount = useMemo(() => {
    let n = 0;
    if (statementHasVoiceViolation(draft.tier1Statement?.text)) n++;
    for (const t2 of draft.tier2Statements) {
      if (statementHasVoiceViolation(t2.text)) n++;
    }
    return n;
  }, [draft]);
  function dismissVoiceBanner() {
    localStorage.setItem(voiceBannerDismissedKey, '1');
    setVoiceBannerDismissed(true);
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
    if (showOrientation) dismissOrientation();
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
    if (showOrientation) dismissOrientation();
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
    if (showOrientation) dismissOrientation();
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

  // Round 3.1 Item A — Fill-this-in submit for autonomous-mode gap
  // observations. Updates the cell text via the existing tier PUT, then
  // resolves the Observation row server-side so the gap doesn't reappear
  // on the next observation reload. Falls back gracefully if the resolve
  // fails — the cell still updated successfully.
  async function handleFillGap(cell: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const observationId = cellObservationIds.get(cell);
    await handleAcceptSuggestion(cell, trimmed);
    if (observationId) {
      try {
        await api.post(`/ai/observations/${observationId}/resolve`, { kind: 'change' });
      } catch (err) {
        console.error('[FillGap] resolve failed (non-fatal):', err);
      }
      setCellObservationIds(prev => {
        const next = new Map(prev);
        next.delete(cell);
        return next;
      });
    }
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
    if (showOrientation) dismissOrientation();
    refreshDraft().then(() => {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 1500);
    });
  }

  async function regenerate() {
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
  const [renamingCheckpointId, setRenamingCheckpointId] = useState<string | null>(null);
  const [renameCheckpointValue, setRenameCheckpointValue] = useState('');

  async function createSnapshot() {
    await api.post(`/versions/table/${draft.id}`, {});
    setShowCheckpointSaved(true);
    setTimeout(() => setShowCheckpointSaved(false), 2000);
    await refreshDraft();
  }

  async function renameCheckpoint(versionId: string, newLabel: string) {
    const trimmed = newLabel.trim();
    if (!trimmed) { setRenamingCheckpointId(null); return; }
    try {
      await api.patch(`/versions/table/${versionId}`, { label: trimmed });
      await refreshDraft();
    } catch {
      // silent
    }
    setRenamingCheckpointId(null);
    setRenameCheckpointValue('');
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
      {(suggestions.size > 0 || (viewMode === 'all-markup' && cellStates.size > 0)) && (
        <div className="review-view-mode" role="group" aria-label="Review view mode">
          <span className="review-view-mode-label">
            {suggestions.size > 0
              ? `I'd adjust ${suggestions.size} cell${suggestions.size !== 1 ? 's' : ''}.`
              : 'No open observations.'}
          </span>
          <span className="review-view-mode-segmented">
            <button
              type="button"
              className={viewMode === 'no-markup' ? 'active' : ''}
              onClick={() => setViewMode('no-markup')}
              title="Hide all markup. Observations stay; only the visual indicators are hidden."
            >Hide markup</button>
            <button
              type="button"
              className={viewMode === 'minimal' ? 'active' : ''}
              onClick={() => setViewMode('minimal')}
              title="Show open observations only."
            >Minimal</button>
            <button
              type="button"
              className={viewMode === 'all-markup' ? 'active' : ''}
              onClick={() => setViewMode('all-markup')}
              title="Show every observation, including ones already resolved."
            >All markup</button>
          </span>
          {showViewModeOrientation && (
            <div className="review-view-mode-orientation">
              <span><strong>New:</strong> "Dismiss all" is now <em>Hide markup</em>. Observations are preserved — just hidden. Switch view modes anytime.</span>
              <button className="btn btn-ghost btn-sm" onClick={dismissViewModeOrientation}>Got it</button>
            </div>
          )}
        </div>
      )}
      <h2 style={{ marginBottom: 4 }}>Foundational Message</h2>
      <p style={{ marginBottom: 16, color: 'var(--text-tertiary)', fontSize: 12, fontStyle: 'italic' }}>
        Based on Three Tier format
      </p>

      {voiceViolationCount > 0 && !voiceBannerDismissed && !refining && !polishing && (
        <div style={{
          padding: '14px 18px',
          marginBottom: 16,
          background: 'var(--accent-light, #eaf4ff)',
          borderRadius: 'var(--radius-md, 10px)',
          border: '1px solid var(--accent, #007aff)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, flex: '1 1 260px' }}>
            I'd tighten {voiceViolationCount === 1 ? 'one statement' : `${voiceViolationCount} statements`} here — the language has a few hedges I'd drop. Want me to touch it up?
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13, padding: '6px 14px' }}
              disabled={refining}
              onClick={() => { dismissVoiceBanner(); refineLanguage(); }}
            >
              {refining ? 'Touching up…' : 'Touch up'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 13, padding: '6px 12px' }}
              onClick={dismissVoiceBanner}
            >
              Skip
            </button>
          </div>
        </div>
      )}

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
          <div style={{ paddingRight: 24 }}>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', margin: '0 0 8px', fontWeight: 500 }}>
              This is a first draft of a Three Tier Message for {draft.audience.name}.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
              Statements start in a literal "You get [value] because [our differentiator]" format so the logic is easy to check. Use <strong>Refine Language</strong> to rewrite them in natural voice. Then <strong>Polish</strong> for a final pass — Polish takes a little longer.
            </p>
          </div>
        </div>
      )}

      {!showOrientation && (
        <p className="step-description">
          Click any cell to edit. Use the tools below to have Maria suggest improvements.
        </p>
      )}

      {/* Direction input — scope-aware */}
      <div className="direction-input" style={{ marginBottom: 16 }}>
        {focusedCell && (() => {
          const t2Match = focusedCell.match(/^tier2-(\d+)$/);
          const t3Match = focusedCell.match(/^tier3-(\d+)-(\d+)$/);
          let label = 'this cell';
          if (focusedCell === 'tier1') {
            label = 'Tier 1';
          } else if (t2Match) {
            const idx = parseInt(t2Match[1]);
            const col = draft.tier2Statements[idx]?.categoryLabel;
            label = col ? `the ${col} column` : `Tier 2 column ${idx + 1}`;
          } else if (t3Match) {
            const t2idx = parseInt(t3Match[1]);
            const col = draft.tier2Statements[t2idx]?.categoryLabel;
            label = col ? `a proof point in ${col}` : 'a proof point';
          }
          return (
            <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 4, fontWeight: 500 }}>
              Scoped to {label}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: '0 6px', marginLeft: 6 }}
                onClick={() => setFocusedCell(null)}
              >clear</button>
            </div>
          );
        })()}
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

      {/* Toolbar — grouped: rewrite cluster | review + state cluster */}
      <div className="three-tier-toolbar">
        {/* Cluster 1: rewrite actions */}
        <button
          className={`btn btn-sm ${hasRefined ? 'btn-secondary' : 'btn-primary'}`}
          onClick={refineLanguage}
          disabled={anyBusy}
          title="Rewrite statements to sound more natural while keeping the meaning"
        >
          {refining ? <><Spinner size={12} /> <RotatingPhrases phase="generic" intervalMs={3500} /></> : 'Refine Language'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={polish} disabled={anyBusy} title="Results are usually better, but take a little longer">
          {polishing ? <><Spinner size={12} /> <RotatingPhrases phase="generic" intervalMs={3500} /></> : 'Polish'}
        </button>
        {/* Divider */}
        <span aria-hidden="true" style={{ display: 'inline-block', width: 1, height: 20, background: 'var(--border-light, #e5e5ea)', margin: '0 4px', alignSelf: 'center' }} />
        {/* Cluster 2: review + state */}
        <button className="btn btn-secondary btn-sm" onClick={askMaria} disabled={anyBusy} title="Maria reviews your message and tells you what she'd improve">
          {reviewing ? <><Spinner size={12} /> <RotatingPhrases phase="mapping" intervalMs={3500} /></> : 'Ask Maria to review'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={createSnapshot} title="Save the current state as a checkpoint you can return to">
          {showCheckpointSaved ? 'Checkpoint saved' : 'Save checkpoint'}
        </button>
        {hasEdited && (
          <button className="btn btn-secondary btn-sm" onClick={reviseFromEdits} disabled={anyBusy} title="Maria revises other cells to match your edits">
            {revising ? <><Spinner size={12} /> <RotatingPhrases phase="rebuild" intervalMs={3500} /></> : 'Match the rest to my edits'}
          </button>
        )}
        <div style={{ position: 'relative' }} ref={moreToolsRef}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowMoreTools(!showMoreTools)} style={{ fontSize: 28, lineHeight: 1, padding: '4px 10px', letterSpacing: 2 }}>
            •••
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
              <button className="btn btn-ghost btn-sm btn-danger" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '8px 14px' }} onClick={() => { setConfirmRegenerate(true); setShowMoreTools(false); }} disabled={anyBusy}>
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
        cellStates={cellStates}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={handleDismissSuggestion}
        onFillGap={handleFillGap}
        tier1Alternative={tier1Alternative}
        focusedCell={focusedCell}
        onCellFocus={setFocusedCell}
        viewMode={viewMode}
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
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #d1d1d6' }}>
            <button className="btn btn-primary btn-sm" onClick={createSnapshot} style={{ width: '100%' }}>
              {showCheckpointSaved ? 'Checkpoint saved' : '+ Save a new checkpoint'}
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {(draft.tableVersions?.length || 0) === 0 && (
              <p style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-tertiary)', margin: 0 }}>
                No checkpoints yet. Save one before making big changes.
              </p>
            )}
            {(draft.tableVersions || []).map((v: TableVersion) => {
              const timeAgo = formatTimeAgo(v.createdAt);
              const isRenaming = renamingCheckpointId === v.id;
              return (
                <div key={v.id} style={{ padding: '10px 20px', borderBottom: '1px solid var(--bg-secondary)', cursor: 'default' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameCheckpointValue}
                        onChange={e => setRenameCheckpointValue(e.target.value)}
                        onBlur={() => renameCheckpoint(v.id, renameCheckpointValue)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') renameCheckpoint(v.id, renameCheckpointValue);
                          if (e.key === 'Escape') { setRenamingCheckpointId(null); setRenameCheckpointValue(''); }
                        }}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', fontSize: 14 }}
                      />
                    ) : (
                      <strong style={{ fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</strong>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0 }}>{timeAgo}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setCompareSnapshot({ snapshot: v.snapshot, label: v.label })}>Compare</button>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setRestoreTarget(v.id)}>Restore</button>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => { setRenamingCheckpointId(v.id); setRenameCheckpointValue(v.label); }}>Rename</button>
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
            Your Three Tier is still in first-draft form. The story may be stronger if you refine the language first.
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-primary btn-sm" onClick={() => { setShowRefineNudge(false); refineLanguage(); }}>
              Refine now
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowRefineNudge(false)}>
              Cancel
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

      <ConfirmModal
        open={confirmRegenerate}
        onClose={() => setConfirmRegenerate(false)}
        onConfirm={regenerate}
        title="Start over?"
        message="Maria will save a snapshot of your current table, then regenerate from scratch."
        confirmLabel="Regenerate"
        confirmDanger
      />
    </div>
  );
}
