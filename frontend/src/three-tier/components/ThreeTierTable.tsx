import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import { CellEditor } from './CellEditor';
import { CellVersionNav } from './CellVersionNav';
import { InfoTooltip } from '../../shared/InfoTooltip';
import { ConfirmModal } from '../../shared/ConfirmModal';
import { useToast } from '../../shared/ToastContext';
import type { ThreeTierDraft } from '../../types';
import { buildTier2EmptyGuidance, DROP_EMPTY_ROW_CHIP } from '../../shared/milestoneCopy';

// Round 3.4 Bug 11 — detect a Tier 2 row that's substantively empty.
// "Empty" = once any [INSERT: ...] gap markers are stripped, the
// remaining text is empty or trivially short. The user needs to see a
// guidance line above the row pointing at what's missing, plus a
// "Drop this row for now" chip that omits the row from the deliverable.
function isTier2RowEmpty(text: string | null | undefined): boolean {
  const stripped = (text || '').replace(/\[INSERT:[^\]]*\]/g, '').trim();
  return stripped.length < 3;
}

// Three-view-mode pattern (Round A1 — orange-highlight system).
//   no-markup  — clean reading view; observations exist but no orange shows
//   minimal    — default; orange on every cell with an OPEN observation
//   all-markup — opt-in busy view; resolved observations also visible (calmer)
export type ReviewViewMode = 'no-markup' | 'minimal' | 'all-markup';

// Resolution state tracked per cell so all-markup can render resolved
// observations in a calmer color than open ones.
export type CellMarkupState = 'open' | 'resolved-change' | 'resolved-ack';

interface ThreeTierTableProps {
  draft: ThreeTierDraft;
  onUpdate: () => void;
  onConflict?: () => void;
  suggestions?: Map<string, string>;
  /** Per-cell markup state. Only present when all-markup view is active and resolved
   *  observations have been fetched. Cells with state 'resolved-*' get the calmer
   *  marker class; cells in `suggestions` always render the open-amber class. */
  cellStates?: Map<string, CellMarkupState>;
  onAcceptSuggestion?: (cell: string, text: string) => void;
  onDismissSuggestion?: (cell: string) => void;
  // Round 3.1 Item A — fill-this-in submit for autonomous-mode gap
  // observations. When the suggestion text starts with the GAP marker,
  // the inline panel renders a text input + "Fill this in" submit
  // instead of the Accept/Discuss pair. Submit calls this callback,
  // which updates the cell and resolves the observation server-side.
  onFillGap?: (cell: string, text: string) => void;
  tier1Alternative?: string | null;
  focusedCell?: string | null;
  onCellFocus?: (cell: string | null) => void;
  viewMode?: ReviewViewMode;
}

interface PendingDelete {
  id: string;
  text: string;
  tier2Id: string;
  timeout: ReturnType<typeof setTimeout>;
}

// Round 3.2 Item 6 — render `[INSERT: <description>]` markers in tier
// text as a styled fill-in affordance instead of literal bracket text.
// Click → inline input → submit replaces the marker with the user's
// text and persists via the tier-update PUT. Honest-gap styling: muted
// + italic + subtle background tint, no flashing or "DO THIS NOW"
// callouts (Beck's flow showed pushy prompts pushed overwhelmed users
// deeper into stuck).
function InsertGap({ description, onApply }: { description: string; onApply: (userText: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');

  if (!editing) {
    return (
      <span
        className="insert-gap-affordance"
        style={{
          fontStyle: 'italic',
          color: 'var(--text-tertiary, #8e8e93)',
          background: 'rgba(255, 200, 100, 0.08)',
          padding: '2px 8px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: '0.92em',
          marginRight: 2,
          marginLeft: 2,
        }}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        title="Click to fill in"
      >
        + Add: {description}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 2, marginLeft: 2 }} onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            onApply(input.trim());
            setEditing(false);
            setInput('');
          }
          if (e.key === 'Escape') {
            setEditing(false);
            setInput('');
          }
        }}
        autoFocus
        placeholder={description}
        style={{
          fontSize: 'inherit',
          padding: '2px 8px',
          border: '1px solid var(--accent, #007aff)',
          borderRadius: 4,
          minWidth: 220,
        }}
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        style={{ padding: '2px 10px', fontSize: 13 }}
        onClick={(e) => {
          e.stopPropagation();
          if (input.trim()) {
            onApply(input.trim());
            setEditing(false);
            setInput('');
          }
        }}
        disabled={!input.trim()}
      >
        Save
      </button>
    </span>
  );
}

function renderTextWithInsertGaps(
  text: string,
  onApply: (newText: string) => void,
): React.ReactNode {
  if (!text) return text;
  const re = /\[INSERT:\s*([^\]\n]+?)\s*\]/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, m.index)}</span>);
    }
    const description = m[1].trim();
    const marker = m[0];
    parts.push(
      <InsertGap
        key={key++}
        description={description}
        onApply={(userText) => {
          const newText = text.replace(marker, userText);
          onApply(newText);
        }}
      />,
    );
    lastIndex = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }
  return <>{parts}</>;
}

export function ThreeTierTable({ draft, onUpdate, onConflict, suggestions, cellStates, onAcceptSuggestion, onFillGap, tier1Alternative, focusedCell, onCellFocus, viewMode = 'minimal' }: ThreeTierTableProps) {
  const { showToast } = useToast();
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Round 3.1 Item A — per-cell text buffer for the gap-fill input. Only
  // populated when a gap observation is active on that cell.
  const [gapDraftByCell, setGapDraftByCell] = useState<Map<string, string>>(new Map());

  // Round 3.1 Item A — gap-marker detector + body extractor. Suggestions
  // prefixed with "[GAP] " are autonomous-mode gap observations and
  // render the input variant of the inline panel.
  function isGapSuggestion(text: string | undefined): boolean {
    return !!(text && text.trimStart().startsWith('[GAP]'));
  }
  function gapBody(text: string): string {
    // Strip the "[GAP]" prefix (with or without trailing whitespace) for
    // display. The marker survives in the persisted suggestion so reloads
    // still trigger the gap variant.
    return text.replace(/^\s*\[GAP\]\s*/, '').trim();
  }
  function getGapDraft(cell: string): string {
    return gapDraftByCell.get(cell) || '';
  }
  function setGapDraft(cell: string, value: string): void {
    setGapDraftByCell(prev => {
      const next = new Map(prev);
      next.set(cell, value);
      return next;
    });
  }
  function submitGap(cell: string): void {
    const text = (gapDraftByCell.get(cell) || '').trim();
    if (!text) return;
    onFillGap?.(cell, text);
    setGapDraftByCell(prev => {
      const next = new Map(prev);
      next.delete(cell);
      return next;
    });
  }

  // Three-view-mode helpers. State (suggestions Map) is preserved across mode
  // switches; viewMode only controls visibility.
  const showOpenMarkup = viewMode !== 'no-markup';
  const showResolvedMarkup = viewMode === 'all-markup';
  function hasOpenSuggestion(cell: string): boolean {
    return !!(suggestions && suggestions.has(cell));
  }
  function cellMarkupClass(cell: string): string {
    if (hasOpenSuggestion(cell) && showOpenMarkup) return ' cell-evaluation-highlight';
    if (showResolvedMarkup && cellStates) {
      const s = cellStates.get(cell);
      if (s === 'resolved-change' || s === 'resolved-ack') return ' cell-evaluation-resolved';
    }
    return '';
  }
  // Inline suggestion panel only renders when there's an open observation AND
  // markup isn't hidden. Replaces the prior column-by-column gating.
  function shouldShowInline(cell: string): boolean {
    return hasOpenSuggestion(cell) && showOpenMarkup;
  }
  // Click on a flagged cell opens Maria scoped to that cell's observation
  // instead of edit mode (only when markup is visible). Unflagged cells, and
  // cells in no-markup view, fall through to edit mode.
  function tryOpenScopedMaria(cell: string, label: string): boolean {
    if (!shouldShowInline(cell)) return false;
    document.dispatchEvent(new CustomEvent('maria-toggle', {
      detail: { open: true, message: `[REVIEW_CELL:${cell}] I want to look at the ${label}.` },
    }));
    return true;
  }
  // Conflict confirmation
  const [showConflict, setShowConflict] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  useEffect(() => { pendingDeleteRef.current = pendingDelete; }, [pendingDelete]);

  useEffect(() => {
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timeout);
        api.delete(`/tiers/${draft.id}/tier3/${pendingDeleteRef.current.id}`).then(() => onUpdate()).catch(() => {});
      }
    };
  }, [draft.id, onUpdate]);

  function handleCellClick(cellKey: string) {
    if (saving) return;
    // Flagged cell + markup visible → Maria scoped (Round A1).
    // Unflagged cell, or no-markup view → edit mode.
    const labels: Record<string, string> = {
      tier1: 'Tier 1 suggestion you have',
    };
    const label = labels[cellKey] || `suggestion you have on this cell`;
    if (tryOpenScopedMaria(cellKey, label)) return;
    setEditingCell(cellKey);
    onCellFocus?.(cellKey);
  }

  async function updateTier1(text: string) {
    if (text && text !== draft.tier1Statement?.text) {
      setSaving(true);
      try {
        await api.put(`/tiers/${draft.id}/tier1`, { text, changeSource: 'manual', version: draft.version });
        onUpdate();
      } catch (err: any) {
        if (err?.status === 409) {
          setShowConflict(true);
          return;
        } else { throw err; }
      } finally { setSaving(false); }
    }
    setEditingCell(null);
    onCellFocus?.(null);
  }

  async function updateTier2(tier2Id: string, text: string, currentText: string) {
    if (text && text !== currentText) {
      setSaving(true);
      try {
        await api.put(`/tiers/${draft.id}/tier2/${tier2Id}`, { text, changeSource: 'manual', version: draft.version });
        onUpdate();
      } catch (err: any) {
        if (err?.status === 409) {
          setShowConflict(true);
          return;
        } else { throw err; }
      } finally { setSaving(false); }
    }
    setEditingCell(null);
    onCellFocus?.(null);
  }

  async function updateTier3(tier3Id: string, text: string, currentText: string) {
    if (text && text !== currentText) {
      setSaving(true);
      try {
        await api.put(`/tiers/${draft.id}/tier3/${tier3Id}`, { text, changeSource: 'manual', version: draft.version });
        onUpdate();
      } catch (err: any) {
        if (err?.status === 409) {
          setShowConflict(true);
          return;
        } else { throw err; }
      } finally { setSaving(false); }
    }
    setEditingCell(null);
    onCellFocus?.(null);
  }

  async function addTier3(tier2Id: string) {
    if (saving) return;
    setSaving(true);
    try {
      await api.post(`/tiers/${draft.id}/tier2/${tier2Id}/tier3`, { text: 'New proof point', changeSource: 'manual' });
      onUpdate();
    } catch {
      showToast('Could not add proof point. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const startDeleteTier3 = useCallback((tier3Id: string, text: string, tier2Id: string) => {
    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeout);
      api.delete(`/tiers/${draft.id}/tier3/${pendingDeleteRef.current.id}`).then(() => onUpdate()).catch(() => {});
    }
    const timeout = setTimeout(() => {
      api.delete(`/tiers/${draft.id}/tier3/${tier3Id}`).then(() => {
        setPendingDelete(null);
        onUpdate();
      });
    }, 5000);
    setPendingDelete({ id: tier3Id, text, tier2Id, timeout });
  }, [draft.id, onUpdate]);

  function undoDeleteTier3() {
    if (pendingDelete) {
      clearTimeout(pendingDelete.timeout);
      setPendingDelete(null);
    }
  }

  function copyTableToClipboard() {
    const tier1 = draft.tier1Statement?.text || '';
    const lines = [tier1, '', '---'];
    for (const t2 of draft.tier2Statements) {
      lines.push('', t2.text);
      for (const t3 of t2.tier3Bullets) lines.push(`  \u2022 ${t3.text}`);
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }

  function esc(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function exportTable() {
    const t1 = draft.tier1Statement?.text || '';
    const t2s = draft.tier2Statements.map(t2 => ({
      label: t2.categoryLabel,
      text: t2.text,
      proofs: t2.tier3Bullets.map(t3 => t3.text),
    }));
    const html = `<!DOCTYPE html>
<html><head><title>Three Tier Message</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #1d1d1f; }
  h1 { font-size: 18px; color: #6e6e73; margin-bottom: 24px; }
  .tier1 { font-size: 20px; font-weight: 600; padding: 20px; background: #f5f5f7; border-radius: 12px; margin-bottom: 24px; }
  .tier2-grid { display: grid; grid-template-columns: repeat(${t2s.length}, 1fr); gap: 16px; }
  .tier2-col { border: 1px solid #d1d1d6; border-radius: 12px; padding: 16px; }
  .tier2-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6e6e73; margin-bottom: 8px; }
  .tier2-text { font-size: 15px; line-height: 1.5; margin-bottom: 12px; }
  .tier3-list { list-style: disc; padding-left: 20px; margin: 0; }
  .tier3-list li { font-size: 13px; color: #6e6e73; line-height: 1.6; }
  .export-bar { background: #f5f5f7; border-radius: 8px; padding: 12px 20px; margin-bottom: 20px; font-size: 13px; color: #6e6e73; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .export-bar span { color: #1d1d1f; font-weight: 500; }
  .save-pdf-btn { background: #007aff; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .save-pdf-btn:hover { background: #0066d6; }
  .export-fallback { font-size: 12px; color: #aeaeb2; margin-top: 4px; }
  @media print { body { margin: 0; } .export-bar { display: none; } }
</style></head><body>
<div class="export-bar">
  <div>
    <button class="save-pdf-btn" onclick="window.print()">Save as PDF</button>
  </div>
  <div style="text-align:right;">
    <div>If the button doesn\u2019t work: <span>Mac</span> \u2318P \u2192 Save as PDF &nbsp; <span>iPad</span> Share \u2192 Print</div>
    <button onclick="this.closest('.export-bar').style.display='none'" style="background:none;border:none;cursor:pointer;font-size:14px;color:#aeaeb2;margin-top:2px;">Dismiss</button>
  </div>
</div>
<h1>Three Tier Message</h1>
<div style="font-size:13px;color:#aeaeb2;margin-bottom:16px;">Exported ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
<div class="tier1">${esc(t1)}</div>
<div class="tier2-grid">
${t2s.map(t2 => `<div class="tier2-col">
  ${t2.label ? `<div class="tier2-label">${esc(t2.label)}</div>` : ''}
  <div class="tier2-text">${esc(t2.text)}</div>
  <ul class="tier3-list">${t2.proofs.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
</div>`).join('')}
</div>
</body></html>`;
    const win = window.open('', '_blank');
    if (!win) { showToast('Export blocked — please allow popups for this site.'); return; }
    win.document.write(html); win.document.close();
  }

  async function shareDraft() {
    try {
      const result = await api.post<{ token: string; url: string }>('/share', { draftId: draft.id });
      const fullUrl = `${window.location.origin}${result.url}`;
      setShareUrl(fullUrl);
      navigator.clipboard.writeText(fullUrl);
    } catch { showToast('Could not create share link.'); }
  }

  const isTier1Focused = focusedCell === 'tier1' || editingCell === 'tier1';

  return (
    <div>
      <div className={`three-tier-table${suggestions && suggestions.size > 0 ? ' has-suggestions' : ''}`}>
        {/* Tier 1 */}
        <div className={`tier1-row${isTier1Focused ? ' cell-focused' : ''}${cellMarkupClass('tier1')}`}>
          <div className="tier-header-row">
            <div className="tier-label">Tier 1 <span className="tier-subtitle">Core Value</span> <InfoTooltip text="The single most important statement for your audience. Connects their #1 priority to your strongest differentiator. The test: does the reader think 'I cannot ignore this'?" /></div>
            <div className="tier-header-actions">
              <button className="btn-copy-table" onClick={copyTableToClipboard} title="Copy entire table to clipboard">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy
              </button>
              <button className="btn-copy-table" onClick={exportTable} title="Open printable version">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                Export
              </button>
              <button className="btn-copy-table" onClick={shareDraft} title="Create shareable read-only link">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                Share
              </button>
            </div>
          </div>
          {shareUrl && (
            <div style={{ padding: '6px 12px', fontSize: 14, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Link copied!</span>
              <code style={{ fontSize: 13, background: 'var(--bg-secondary, #f5f5f7)', padding: '4px 8px', borderRadius: 4 }}>{shareUrl}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => setShareUrl(null)} style={{ minWidth: 32, minHeight: 32 }}>&times;</button>
            </div>
          )}
          {editingCell === 'tier1' ? (
            <CellEditor
              text={draft.tier1Statement?.text || ''}
              maxWords={20}
              onSave={updateTier1}
              onCancel={() => { setEditingCell(null); onCellFocus?.(null); }}
            />
          ) : (
            <div className="tier1-text" onClick={() => handleCellClick('tier1')}>
              {draft.tier1Statement?.text
                ? renderTextWithInsertGaps(draft.tier1Statement.text, (newText) => updateTier1(newText))
                : 'Click to add Tier 1 statement'}
            </div>
          )}
          {shouldShowInline('tier1') && (
            <div className="inline-suggestion">
              {isGapSuggestion(suggestions!.get('tier1')) ? (
                // Round 3.1 Item A — gap-fill input variant.
                <>
                  <span className="inline-suggestion-text">{gapBody(suggestions!.get('tier1')!)}</span>
                  <div className="inline-suggestion-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 8 }}>
                    <input
                      type="text"
                      value={getGapDraft('tier1')}
                      onChange={e => setGapDraft('tier1', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submitGap('tier1'); }}
                      placeholder="Type the missing input"
                      style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-light, #e5e5ea)', fontSize: 13 }}
                    />
                    <button
                      className="inline-suggestion-accept"
                      onClick={() => submitGap('tier1')}
                      disabled={!getGapDraft('tier1').trim()}
                    >
                      Fill this in
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="inline-suggestion-text">{suggestions!.get('tier1')}</span>
                  <div className="inline-suggestion-actions">
                    <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.('tier1', suggestions!.get('tier1')!)}>Accept</button>
                    <button className="inline-suggestion-dismiss" onClick={(e) => {
                      e.stopPropagation();
                      // Discuss-with-Maria replaces silent Dismiss. Opens scoped chat
                      // where the user can change the cell or acknowledge-as-is.
                      document.dispatchEvent(new CustomEvent('maria-toggle', {
                        detail: { open: true, message: `[REVIEW_CELL:tier1] I want to look at the Tier 1 suggestion you have.` },
                      }));
                    }}>Discuss</button>
                  </div>
                  {tier1Alternative && (
                    <div
                      style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, cursor: 'pointer', lineHeight: 1.5 }}
                      onClick={() => onAcceptSuggestion?.('tier1', tier1Alternative)}
                    >
                      I also have a more straightforward version: <em>"{tier1Alternative}"</em>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {draft.tier1Statement && (
            <CellVersionNav
              cellId={draft.tier1Statement.id}
              cellType="tier1"
              currentText={draft.tier1Statement.text}
              draftVersion={draft.version}
              onRestore={() => onUpdate()}
            />
          )}
        </div>

        {/* Tier 2 + Tier 3 */}
        <div className="tier2-row">
          {draft.tier2Statements.map((t2, t2Index) => {
            const t2Key = `tier2-${t2Index}`;
            const isColFocused = focusedCell === t2Key || editingCell === `tier2-${t2.id}`;
            return (
              <div key={t2.id} className={`tier2-col${isColFocused ? ' cell-focused' : ''}${cellMarkupClass(t2Key)}`}>
                <div
                  className="tier-label tier-label-small"
                  onClick={() => {
                    // Change 1 — Foundation walkthrough: tapping a Tier 2 column header
                    // opens Maria scoped to that column with the column-specific question
                    // pre-loaded. partner.ts handles the [REVIEW_TIER2_COLUMN:Label] marker.
                    const label = t2.categoryLabel || 'Supporting Value';
                    document.dispatchEvent(new CustomEvent('maria-toggle', {
                      detail: { open: true, message: `[REVIEW_TIER2_COLUMN:${label}]` },
                    }));
                  }}
                  style={{ cursor: 'pointer' }}
                  title="Tap to ask Maria about this column"
                >Tier 2 {t2.categoryLabel ? <span className="tier-subtitle">{t2.categoryLabel}</span> : <span className="tier-subtitle">Supporting Value</span>} {t2Index === 0 && <InfoTooltip text="Each supporting statement reinforces your key message from a different angle — your focus, product, ROI, support commitment, and proof from other customers." />}</div>
                {editingCell === `tier2-${t2.id}` ? (
                  <div style={{ padding: 8 }}>
                    <CellEditor
                      text={t2.text}
                      maxWords={20}
                      onSave={(text) => updateTier2(t2.id, text, t2.text)}
                      onCancel={() => { setEditingCell(null); onCellFocus?.(null); }}
                    />
                  </div>
                ) : (
                  <>
                    {isTier2RowEmpty(t2.text) && (
                      <div
                        className="tier2-empty-guidance"
                        style={{
                          fontSize: 13,
                          lineHeight: 1.45,
                          color: '#6e6e73',
                          background: '#f7f7fa',
                          border: '1px solid #e5e5ea',
                          borderRadius: 8,
                          padding: '10px 12px',
                          marginBottom: 10,
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>
                          {buildTier2EmptyGuidance(t2.categoryLabel || 'This column')}
                        </div>
                        <button
                          className="tier2-empty-drop-chip"
                          onClick={async () => {
                            try {
                              await api.delete(`/tiers/${draft.id}/tier2/${t2.id}`);
                              onUpdate();
                              showToast(`Dropped "${t2.categoryLabel || 'column'}" — Maria will work without it.`);
                            } catch (err: any) {
                              showToast(`Couldn't drop the row: ${err?.message || 'unknown error'}`);
                            }
                          }}
                          style={{
                            fontSize: 12,
                            padding: '4px 10px',
                            borderRadius: 14,
                            border: '1px solid #d1d1d6',
                            background: '#ffffff',
                            color: '#3a3a3c',
                            cursor: 'pointer',
                          }}
                        >
                          {DROP_EMPTY_ROW_CHIP}
                        </button>
                      </div>
                    )}
                    <div className="tier2-text" onClick={() => handleCellClick(`tier2-${t2.id}`)}>
                      {renderTextWithInsertGaps(t2.text, (newText) => updateTier2(t2.id, newText, t2.text))}
                    </div>
                  </>
                )}
                {shouldShowInline(t2Key) && (
                  <div className="inline-suggestion">
                    {isGapSuggestion(suggestions!.get(t2Key)) ? (
                      // Round 3.1 Item A — gap-fill input variant.
                      <>
                        <span className="inline-suggestion-text">{gapBody(suggestions!.get(t2Key)!)}</span>
                        <div className="inline-suggestion-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 8 }}>
                          <input
                            type="text"
                            value={getGapDraft(t2Key)}
                            onChange={e => setGapDraft(t2Key, e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') submitGap(t2Key); }}
                            placeholder="Type the missing input"
                            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-light, #e5e5ea)', fontSize: 13 }}
                          />
                          <button
                            className="inline-suggestion-accept"
                            onClick={() => submitGap(t2Key)}
                            disabled={!getGapDraft(t2Key).trim()}
                          >
                            Fill this in
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="inline-suggestion-text">{suggestions!.get(t2Key)}</span>
                        <div className="inline-suggestion-actions">
                          <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(t2Key, suggestions!.get(t2Key)!)}>Accept</button>
                          <button className="inline-suggestion-dismiss" onClick={(e) => {
                            e.stopPropagation();
                            const label = t2.categoryLabel || `column ${t2Index + 1}`;
                            document.dispatchEvent(new CustomEvent('maria-toggle', {
                              detail: { open: true, message: `[REVIEW_CELL:${t2Key}] I want to look at the suggestion you have on the ${label} column.` },
                            }));
                          }}>Discuss</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <CellVersionNav
                  cellId={t2.id}
                  cellType="tier2"
                  currentText={t2.text}
                  draftVersion={draft.version}
                  onRestore={() => onUpdate()}
                />

                <div className="tier3-area">
                  <div className="tier-label tier-label-small">Tier 3 <span className="tier-subtitle">Proof Points</span> {t2Index === 0 && <InfoTooltip text="Specific, verifiable facts — numbers, names, certifications, measurable outcomes. A skeptic should be able to check each one independently." />}</div>
                  {t2.tier3Bullets.map((t3, t3Index) => {
                    const t3Key = `tier3-${t2Index}-${t3Index}`;
                    const isPendingDelete = pendingDelete?.id === t3.id;
                    return (
                      <div key={t3.id} style={{ position: 'relative' }}>
                        {editingCell === `tier3-${t3.id}` ? (
                          <CellEditor
                            text={t3.text}
                            maxWords={6}
                            onSave={(text) => updateTier3(t3.id, text, t3.text)}
                            onCancel={() => { setEditingCell(null); onCellFocus?.(null); }}
                          />
                        ) : (
                          <div
                            className={`tier3-bullet${isPendingDelete ? ' tier3-pending-delete' : ''}${focusedCell === `tier3-${t3.id}` ? ' cell-focused' : ''}${cellMarkupClass(t3Key)}`}
                            onClick={() => {
                              if (isPendingDelete) return;
                              // Flagged proof point + markup visible → Maria scoped.
                              // Otherwise → edit mode (uses the bullet id, not the index key).
                              if (tryOpenScopedMaria(t3Key, 'proof-point suggestion you have')) return;
                              handleCellClick(`tier3-${t3.id}`);
                            }}
                          >
                            <span>{renderTextWithInsertGaps(t3.text, (newText) => updateTier3(t3.id, newText, t3.text))}</span>
                            {isPendingDelete ? (
                              <span className="tier3-undo" onClick={(e) => { e.stopPropagation(); undoDeleteTier3(); }}>Undo</span>
                            ) : (
                              <button
                                className="btn btn-ghost btn-sm btn-danger"
                                onClick={(e) => { e.stopPropagation(); startDeleteTier3(t3.id, t3.text, t2.id); }}
                                style={{ padding: '2px 6px', fontSize: 18, opacity: 0.4 }}
                              >
                                &times;
                              </button>
                            )}
                          </div>
                        )}
                        {shouldShowInline(t3Key) && (
                          <div className="inline-suggestion">
                            <span className="inline-suggestion-text">{suggestions!.get(t3Key)}</span>
                            <div className="inline-suggestion-actions">
                              <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(t3Key, suggestions!.get(t3Key)!)}>Accept</button>
                              <button className="inline-suggestion-dismiss" onClick={(e) => {
                                e.stopPropagation();
                                document.dispatchEvent(new CustomEvent('maria-toggle', {
                                  detail: { open: true, message: `[REVIEW_CELL:${t3Key}] I want to look at the proof-point suggestion you have.` },
                                }));
                              }}>Discuss</button>
                            </div>
                          </div>
                        )}
                        <CellVersionNav
                          cellId={t3.id}
                          cellType="tier3"
                          currentText={t3.text}
                          draftVersion={draft.version}
                          onRestore={() => onUpdate()}
                        />
                      </div>
                    );
                  })}
                  {/* Suggestion to ADD a new proof point */}
                  {shouldShowInline(`tier3-${t2Index}-add`) && (
                    <div className="inline-suggestion">
                      <span className="inline-suggestion-text">{suggestions!.get(`tier3-${t2Index}-add`)}</span>
                      <div className="inline-suggestion-actions">
                        <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(`tier3-${t2Index}-add`, suggestions!.get(`tier3-${t2Index}-add`)!)}>Add</button>
                        <button className="inline-suggestion-dismiss" onClick={(e) => {
                          e.stopPropagation();
                          document.dispatchEvent(new CustomEvent('maria-toggle', {
                            detail: { open: true, message: `[REVIEW_CELL:tier3-${t2Index}-add] I want to look at the proof-point you'd add.` },
                          }));
                        }}>Discuss</button>
                      </div>
                    </div>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => addTier3(t2.id)}
                    style={{ fontSize: 13, marginTop: 4, padding: '2px 8px' }}
                  >
                    + Add proof
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmModal
        open={showConflict}
        onClose={() => setShowConflict(false)}
        onConfirm={() => { setShowConflict(false); onConflict?.(); }}
        title="Editing conflict"
        message="Someone else edited this cell. Reload their version, or cancel to keep your text."
        confirmLabel="Reload"
        confirmDanger={false}
      />
    </div>
  );
}
