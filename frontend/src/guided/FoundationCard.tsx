import { useState } from 'react';
import type { FoundationData } from './types';
import { IntentIcon } from './IntentIcon';

interface Props {
  foundation: FoundationData;
  onConfirm: (foundation: FoundationData) => void;
  onRefineLanguage?: () => void;
  onElementClick?: (elementType: string, label: string, text: string) => void;
}

export function FoundationCard({ foundation, onConfirm, onRefineLanguage, onElementClick }: Props) {
  const [state, setState] = useState<FoundationData>(foundation);
  const [editingTier1, setEditingTier1] = useState(false);
  const [editingTier2, setEditingTier2] = useState<string | null>(null);
  const [editingTier3, setEditingTier3] = useState<string | null>(null);

  function updateTier1(text: string) {
    setState(s => ({
      ...s,
      tier1: s.tier1 ? { ...s.tier1, text } : null,
    }));
  }

  function updateTier2(id: string, text: string) {
    setState(s => ({
      ...s,
      tier2: s.tier2.map(t => t.id === id ? { ...t, text } : t),
    }));
  }

  function updateTier3(tier2Id: string, tier3Id: string, text: string) {
    setState(s => ({
      ...s,
      tier2: s.tier2.map(t =>
        t.id === tier2Id
          ? { ...t, tier3: t.tier3.map(b => b.id === tier3Id ? { ...b, text } : b) }
          : t,
      ),
    }));
  }

  return (
    <div className="guided-foundation-card">
      {/* ── Tier 1 — Key Message ──────────────── */}
      {state.tier1 && (
        <div className="guided-foundation-tier1">
          <div className="guided-foundation-tier1-label">Key Message <IntentIcon elementType="tier1" /></div>
          {editingTier1 ? (
            <textarea
              className="guided-foundation-tier1-edit"
              value={state.tier1.text}
              onChange={e => updateTier1(e.target.value)}
              onBlur={() => setEditingTier1(false)}
              rows={3}
              autoFocus
            />
          ) : (
            <div
              className="guided-foundation-tier1-text guided-foundation-editable guided-foundation-maria-generated"
              onClick={() => setEditingTier1(true)}
              onDoubleClick={() => onElementClick?.('tier1', 'Key Message', state.tier1?.text || '')}
            >
              {state.tier1.text}
              <span className="guided-foundation-edit-hint">click to edit</span>
            </div>
          )}
        </div>
      )}

      {/* ── Tier 2 — Supporting Messages ────── */}
      <div className="guided-foundation-tier2-label">Supporting statements — each reinforces your key message from a different angle</div>
      <div className="guided-foundation-tier2-grid">
        {state.tier2.map(t2 => (
          <div key={t2.id} className="guided-foundation-column">
            <div className="guided-foundation-column-label">
              {t2.categoryLabel || 'Supporting'}{' '}
              <IntentIcon elementType={
                (t2.categoryLabel || '').toLowerCase().includes('focus') ? 'tier2_focus'
                : (t2.categoryLabel || '').toLowerCase().includes('roi') ? 'tier2_roi'
                : (t2.categoryLabel || '').toLowerCase().includes('support') ? 'tier2_support'
                : (t2.categoryLabel || '').toLowerCase().includes('proof') || (t2.categoryLabel || '').toLowerCase().includes('social') ? 'tier2_proof'
                : 'tier2_product'
              } />
            </div>

            {editingTier2 === t2.id ? (
              <textarea
                className="guided-foundation-tier2-edit"
                value={t2.text}
                onChange={e => updateTier2(t2.id, e.target.value)}
                onBlur={() => setEditingTier2(null)}
                rows={3}
                autoFocus
              />
            ) : (
              <div
                className="guided-foundation-tier2-text guided-foundation-editable"
                onClick={() => setEditingTier2(t2.id)}
              >
                {t2.text}
              </div>
            )}

            {/* Tier 3 — Proof */}
            <div className="guided-foundation-tier3">
              {t2.tier3.map(b => (
                <div key={b.id} className="guided-foundation-proof">
                  {editingTier3 === b.id ? (
                    <input
                      className="guided-foundation-proof-edit"
                      value={b.text}
                      onChange={e => updateTier3(t2.id, b.id, e.target.value)}
                      onBlur={() => setEditingTier3(null)}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="guided-foundation-proof-text"
                      onClick={() => setEditingTier3(b.id)}
                      title="Click to edit"
                    >
                      {b.text}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Actions ───────────────────────────── */}
      <div className="guided-foundation-actions">
        {onRefineLanguage && (
          <button
            type="button"
            className="btn guided-foundation-refine"
            onClick={onRefineLanguage}
            title="Open the full three-tier editor with Maria — edit any cell, scope her to one column, run Refine Language or Polish"
          >
            Open in full editor
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary guided-foundation-confirm"
          onClick={() => onConfirm(state)}
        >
          Use this foundation
        </button>
      </div>
      <p className="guided-foundation-actions-hint">
        Click any line above to edit it here. For deeper control — scoped edits, alternate drafts, checkpoints — use the full editor.
      </p>
    </div>
  );
}
