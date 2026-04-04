import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import { CellEditor } from './CellEditor';
import { CellVersionNav } from './CellVersionNav';
import { InfoTooltip } from '../../shared/InfoTooltip';
import { ConfirmModal } from '../../shared/ConfirmModal';
import { useToast } from '../../shared/ToastContext';
import type { ThreeTierDraft } from '../../types';

interface ThreeTierTableProps {
  draft: ThreeTierDraft;
  onUpdate: () => void;
  onConflict?: () => void;
  suggestions?: Map<string, string>;
  onAcceptSuggestion?: (cell: string, text: string) => void;
  onDismissSuggestion?: (cell: string) => void;
  tier1Alternative?: string | null;
  focusedCell?: string | null;
  onCellFocus?: (cell: string | null) => void;
}

interface PendingDelete {
  id: string;
  text: string;
  tier2Id: string;
  timeout: ReturnType<typeof setTimeout>;
}

export function ThreeTierTable({ draft, onUpdate, onConflict, suggestions, onAcceptSuggestion, onDismissSuggestion, tier1Alternative, focusedCell, onCellFocus }: ThreeTierTableProps) {
  const { showToast } = useToast();
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Suggestion focus: show one column at a time
  const [activeReviewCol, setActiveReviewCol] = useState<number>(-1); // -1 = tier1, 0+ = tier2 index

  // Compute which columns have suggestions
  const colsWithSuggestions: number[] = [];
  if (suggestions && suggestions.size > 0) {
    if (suggestions.has('tier1')) colsWithSuggestions.push(-1);
    for (let i = 0; i < draft.tier2Statements.length; i++) {
      const hasT2 = suggestions.has(`tier2-${i}`);
      const hasT3 = draft.tier2Statements[i].tier3Bullets.some((_, j) => suggestions.has(`tier3-${i}-${j}`));
      const hasAdd = suggestions.has(`tier3-${i}-add`);
      if (hasT2 || hasT3 || hasAdd) colsWithSuggestions.push(i);
    }
  }

  // Auto-set active column when suggestions first appear
  useEffect(() => {
    if (colsWithSuggestions.length > 0 && !colsWithSuggestions.includes(activeReviewCol)) {
      setActiveReviewCol(colsWithSuggestions[0]);
    }
    if (colsWithSuggestions.length === 0) {
      setActiveReviewCol(-1);
    }
  }, [suggestions?.size]);

  function isSuggestionVisible(cell: string): boolean {
    if (!suggestions || suggestions.size === 0) return false;
    if (colsWithSuggestions.length === 0) return false;
    if (cell === 'tier1') return activeReviewCol === -1;
    const match = cell.match(/^tier[23]-(\d+)/);
    if (match) return parseInt(match[1]) === activeReviewCol;
    return false;
  }

  function nextReviewCol() {
    const idx = colsWithSuggestions.indexOf(activeReviewCol);
    if (idx < colsWithSuggestions.length - 1) setActiveReviewCol(colsWithSuggestions[idx + 1]);
  }
  function prevReviewCol() {
    const idx = colsWithSuggestions.indexOf(activeReviewCol);
    if (idx > 0) setActiveReviewCol(colsWithSuggestions[idx - 1]);
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
        api.delete(`/tiers/${draft.id}/tier3/${pendingDeleteRef.current.id}`).then(() => onUpdate());
      }
    };
  }, [draft.id, onUpdate]);

  function handleCellClick(cellKey: string) {
    if (saving) return;
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
    await api.post(`/tiers/${draft.id}/tier2/${tier2Id}/tier3`, { text: 'New proof point', changeSource: 'manual' });
    onUpdate();
  }

  const startDeleteTier3 = useCallback((tier3Id: string, text: string, tier2Id: string) => {
    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeout);
      api.delete(`/tiers/${draft.id}/tier3/${pendingDeleteRef.current.id}`).then(() => onUpdate());
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
  @media print { body { margin: 0; } }
</style></head><body>
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
        {/* Suggestion navigation */}
        {colsWithSuggestions.length > 0 && (
          <div style={{
            padding: '8px 16px',
            background: 'rgba(0, 122, 255, 0.04)',
            borderBottom: '1px solid #d1d1d6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}>
            <span>
              Reviewing {activeReviewCol === -1 ? 'Tier 1' : `column ${activeReviewCol + 1}${draft.tier2Statements[activeReviewCol]?.categoryLabel ? ` (${draft.tier2Statements[activeReviewCol].categoryLabel})` : ''}`}
              {' '}&middot; {colsWithSuggestions.indexOf(activeReviewCol) + 1} of {colsWithSuggestions.length}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 8px', fontSize: 12 }}
                onClick={prevReviewCol}
                disabled={colsWithSuggestions.indexOf(activeReviewCol) <= 0}
              >&lsaquo; Prev</button>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 8px', fontSize: 12 }}
                onClick={nextReviewCol}
                disabled={colsWithSuggestions.indexOf(activeReviewCol) >= colsWithSuggestions.length - 1}
              >Next &rsaquo;</button>
            </div>
          </div>
        )}

        {/* Tier 1 */}
        <div className={`tier1-row${isTier1Focused ? ' cell-focused' : ''}`}>
          <div className="tier-header-row">
            <div className="tier-label">Tier 1 <span className="tier-subtitle">Core Value</span> <InfoTooltip text="Your single most important value statement \u2014 the headline of your message." /></div>
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
              {draft.tier1Statement?.text || 'Click to add Tier 1 statement'}
            </div>
          )}
          {suggestions?.has('tier1') && isSuggestionVisible('tier1') && (
            <div className="inline-suggestion">
              <span className="inline-suggestion-text">{suggestions.get('tier1')}</span>
              <div className="inline-suggestion-actions">
                <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.('tier1', suggestions.get('tier1')!)}>Accept</button>
                <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.('tier1'); }}>Dismiss</button>
              </div>
              {tier1Alternative && (
                <div
                  style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, cursor: 'pointer', lineHeight: 1.5 }}
                  onClick={() => onAcceptSuggestion?.('tier1', tier1Alternative)}
                >
                  I also have a more straightforward version: <em>"{tier1Alternative}"</em>
                </div>
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
        <div className="tier-label">Tier 2 <span className="tier-subtitle">Supporting Values</span> <InfoTooltip text="Each column maps one of your audience's priorities to what you offer." /></div>
        <div className="tier2-row">
          {draft.tier2Statements.map((t2, t2Index) => {
            const t2Key = `tier2-${t2Index}`;
            const isColFocused = focusedCell === t2Key || editingCell === `tier2-${t2.id}`;
            return (
              <div key={t2.id} className={`tier2-col${isColFocused ? ' cell-focused' : ''}`}>
                {t2.categoryLabel && (
                  <div className="tier2-category-label">{t2.categoryLabel}</div>
                )}
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
                  <div className="tier2-text" onClick={() => handleCellClick(`tier2-${t2.id}`)}>
                    {t2.text}
                  </div>
                )}
                {suggestions?.has(t2Key) && isSuggestionVisible(t2Key) && (
                  <div className="inline-suggestion">
                    <span className="inline-suggestion-text">{suggestions.get(t2Key)}</span>
                    <div className="inline-suggestion-actions">
                      <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(t2Key, suggestions.get(t2Key)!)}>Accept</button>
                      <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.(t2Key); }}>Dismiss</button>
                    </div>
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
                  <div className="tier-label tier-label-small">Tier 3 <span className="tier-subtitle">Proof Points</span> <InfoTooltip text="Brief facts that prove this value is true. If a skeptic couldn\u2019t verify it, it\u2019s not proof." /></div>
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
                          <div className={`tier3-bullet${isPendingDelete ? ' tier3-pending-delete' : ''}${focusedCell === `tier3-${t3.id}` ? ' cell-focused' : ''}`} onClick={() => !isPendingDelete && handleCellClick(`tier3-${t3.id}`)}>
                            <span>{t3.text}</span>
                            {isPendingDelete ? (
                              <span className="tier3-undo" onClick={(e) => { e.stopPropagation(); undoDeleteTier3(); }}>Undo</span>
                            ) : (
                              <button
                                className="btn btn-ghost btn-sm btn-danger"
                                onClick={(e) => { e.stopPropagation(); startDeleteTier3(t3.id, t3.text, t2.id); }}
                                style={{ padding: '0 4px', fontSize: 12, opacity: 0.4 }}
                              >
                                &times;
                              </button>
                            )}
                          </div>
                        )}
                        {suggestions?.has(t3Key) && isSuggestionVisible(t3Key) && (
                          <div className="inline-suggestion">
                            <span className="inline-suggestion-text">{suggestions.get(t3Key)}</span>
                            <div className="inline-suggestion-actions">
                              <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(t3Key, suggestions.get(t3Key)!)}>Accept</button>
                              <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.(t3Key); }}>Dismiss</button>
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
                  {suggestions?.has(`tier3-${t2Index}-add`) && isSuggestionVisible(`tier3-${t2Index}-add`) && (
                    <div className="inline-suggestion">
                      <span className="inline-suggestion-text">{suggestions.get(`tier3-${t2Index}-add`)}</span>
                      <div className="inline-suggestion-actions">
                        <button className="inline-suggestion-accept" onClick={() => onAcceptSuggestion?.(`tier3-${t2Index}-add`, suggestions.get(`tier3-${t2Index}-add`)!)}>Add</button>
                        <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.(`tier3-${t2Index}-add`); }}>Dismiss</button>
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
