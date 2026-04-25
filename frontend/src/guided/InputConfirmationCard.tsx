import { useState, useRef } from 'react';
import type { EnrichedInterpretation, FactSource } from './types';

interface Props {
  interpretation: EnrichedInterpretation;
  onConfirm: (edited: EnrichedInterpretation) => void;
}

export function InputConfirmationCard({ interpretation, onConfirm }: Props) {
  const [state, setState] = useState<EnrichedInterpretation>(interpretation);
  // Change 8 — Provenance verification: track which inferred items the user has
  // explicitly verified (either tapped "looks right" or edited). Build is gated
  // on all inferred items being verified so Maria's authorship doesn't sneak
  // into Tier 1 by default.
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  function markVerified(key: string) {
    setVerifiedKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  // ── Differentiator editing ──────────────────────────
  function updateDiff(index: number, field: 'text' | 'motivatingFactor', value: string) {
    // When a user edits an inferred item, that's verification by edit — the
    // text is now user-authored, so we mark it verified AND flip source to 'stated'.
    markVerified(`diff-${index}`);
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: s.offering.differentiators.map((d, i) =>
          i === index ? { ...d, [field]: value, source: 'stated' as FactSource } : d,
        ),
      },
    }));
  }

  function removeDiff(index: number) {
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: s.offering.differentiators.filter((_, i) => i !== index),
      },
    }));
  }

  function addDiff() {
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: [...s.offering.differentiators, { text: '', source: 'stated', motivatingFactor: '' }],
      },
    }));
  }

  // ── Priority editing (first audience) ──────────────
  function updatePriority(index: number, field: 'text' | 'driver', value: string) {
    markVerified(`pri-${index}`);
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, ai) =>
        ai === 0
          ? {
              ...a,
              priorities: a.priorities.map((p, pi) =>
                pi === index ? { ...p, [field]: value, source: 'stated' as FactSource } : p,
              ),
            }
          : a,
      ),
    }));
  }

  function removePriority(index: number) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, ai) =>
        ai === 0
          ? { ...a, priorities: a.priorities.filter((_, pi) => pi !== index) }
          : a,
      ),
    }));
  }

  function addPriority() {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, ai) =>
        ai === 0
          ? { ...a, priorities: [...a.priorities, { text: '', source: 'stated', driver: '' }] }
          : a,
      ),
    }));
  }

  // ── Priority drag-to-reorder ────────────────────────
  function handleDragStart(index: number) {
    dragItem.current = index;
  }

  function handleDragEnter(index: number) {
    dragOver.current = index;
  }

  function handleDragEnd() {
    if (dragItem.current === null || dragOver.current === null) return;
    if (dragItem.current === dragOver.current) return;

    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, ai) => {
        if (ai !== 0) return a;
        const items = [...a.priorities];
        const dragged = items.splice(dragItem.current!, 1)[0];
        items.splice(dragOver.current!, 0, dragged);
        return { ...a, priorities: items };
      }),
    }));
    dragItem.current = null;
    dragOver.current = null;
  }

  const audience = state.audiences[0];
  if (!audience) return null;

  // Change 8 — Provenance breakdown for the headline.
  const totalDiffs = state.offering.differentiators.length;
  const statedDiffs = state.offering.differentiators.filter(d => d.source === 'stated').length;
  const inferredDiffs = totalDiffs - statedDiffs;

  const totalPriorities = audience.priorities.length;
  const statedPriorities = audience.priorities.filter(p => p.source === 'stated').length;
  const inferredPriorities = totalPriorities - statedPriorities;

  // Inferred items still pending verification — used to gate the Build button.
  const pendingInferredDiffs = state.offering.differentiators
    .map((d, i) => ({ d, i }))
    .filter(({ d, i }) => d.source === 'inferred' && !verifiedKeys.has(`diff-${i}`));
  const pendingInferredPriorities = audience.priorities
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p.source === 'inferred' && !verifiedKeys.has(`pri-${i}`));
  const allInferredVerified = pendingInferredDiffs.length === 0 && pendingInferredPriorities.length === 0;

  return (
    <div className="guided-input-card">
      {/* ── Summary ────────────────────────────────── */}
      <div className="guided-card-summary">
        Before I draft Tier 1, I want to check a couple of things I drew from context — quick yes/no on each.
        {(inferredDiffs > 0 || inferredPriorities > 0) && (
          <div style={{ marginTop: 8, fontSize: '0.92em', opacity: 0.85 }}>
            I found {totalDiffs} {totalDiffs === 1 ? 'differentiator' : 'differentiators'} — {statedDiffs} from what you told me, {inferredDiffs} I drafted from context. And {totalPriorities} {totalPriorities === 1 ? 'priority' : 'priorities'} — {statedPriorities} stated, {inferredPriorities} drafted.
          </div>
        )}
      </div>

      {/* ── Capabilities with MFs ──────────────────── */}
      <div className="guided-card-section">
        <h3 className="guided-card-section-title">What makes you different</h3>
        {state.offering.differentiators.some(d => d.source === 'inferred') && (
          <p className="guided-card-inferred-note">Items with a rose border are things I drafted from context — I wrote the first version. Check that I got them right.</p>
        )}
        <div className="guided-card-items">
          {state.offering.differentiators.map((d, i) => (
            <div key={i} className={`guided-card-item ${d.source === 'inferred' ? 'guided-card-item-inferred' : ''}`}>
              <div className="guided-card-item-header">
                <span className="guided-card-item-check">✓</span>
                <textarea
                  className="guided-card-item-text guided-card-item-textarea"
                  value={d.text}
                  onChange={e => { updateDiff(i, 'text', e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                  placeholder="A capability or differentiator"
                  rows={1}
                  ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                />
                <button
                  type="button"
                  className="guided-card-remove"
                  onClick={() => removeDiff(i)}
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
              <div className="guided-card-mf">
                <span className="guided-card-mf-label">Why would someone crave this?</span>
                <textarea
                  className="guided-card-mf-text"
                  value={d.motivatingFactor}
                  onChange={e => updateDiff(i, 'motivatingFactor', e.target.value)}
                  placeholder="Why would someone crave this capability?"
                  rows={2}
                />
              </div>
              {/* Change 8 — Provenance verification: only inferred items show this surface. */}
              {d.source === 'inferred' && !verifiedKeys.has(`diff-${i}`) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(0,0,0,0.08)' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => markVerified(`diff-${i}`)}
                  >
                    Looks right
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => {
                      // Tap-to-edit: focus the textarea above so the user can adjust.
                      // Editing it will mark verified via updateDiff.
                      const ta = document.querySelectorAll('.guided-card-item-textarea')[i] as HTMLTextAreaElement | undefined;
                      ta?.focus();
                      ta?.select();
                    }}
                  >
                    Not quite — let me edit
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="guided-card-add" onClick={addDiff}>
          + Something I missed?
        </button>
      </div>

      {/* ── Priorities with drivers ────────────────── */}
      <div className="guided-card-section">
        <h3 className="guided-card-section-title">
          Writing to: {audience.name}
        </h3>
        <p className="guided-card-section-subtitle">What keeps them up at night</p>
        <div className="guided-card-items">
          {audience.priorities.map((p, i) => (
            <div
              key={i}
              className={`guided-card-item guided-card-priority ${p.source === 'inferred' ? 'guided-card-item-inferred' : ''}`}
              draggable
              onDragStart={() => handleDragStart(i)}
              onDragEnter={() => handleDragEnter(i)}
              onDragEnd={handleDragEnd}
              onDragOver={e => e.preventDefault()}
            >
              <div className="guided-card-item-header">
                <span className="guided-card-drag-handle" title="Drag to reorder priorities — #1 matters most">⋮⋮</span>
                <span className="guided-card-item-rank">{i + 1}</span>
                <textarea
                  className="guided-card-item-text guided-card-item-textarea"
                  value={p.text}
                  onChange={e => { updatePriority(i, 'text', e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                  placeholder="Something they actually care about"
                  rows={1}
                  ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                />
                <button
                  type="button"
                  className="guided-card-remove"
                  onClick={() => removePriority(i)}
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
              <div className="guided-card-driver">
                <span className="guided-card-driver-label">Why does THIS person care?</span>
                <textarea
                  className="guided-card-driver-text"
                  value={p.driver}
                  onChange={e => updatePriority(i, 'driver', e.target.value)}
                  placeholder="Why does THIS person care about this priority?"
                  rows={2}
                />
              </div>
              {/* Change 8 — Provenance verification: only inferred priorities show this surface. */}
              {p.source === 'inferred' && !verifiedKeys.has(`pri-${i}`) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(0,0,0,0.08)' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => markVerified(`pri-${i}`)}
                  >
                    Looks right
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => {
                      // Focus the priority textarea so the user can adjust.
                      const tas = document.querySelectorAll('.guided-card-priority .guided-card-item-textarea');
                      const ta = tas[i] as HTMLTextAreaElement | undefined;
                      ta?.focus();
                      ta?.select();
                    }}
                  >
                    Not quite — let me edit
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="guided-card-add" onClick={addPriority}>
          + Add a priority
        </button>
        <p className="guided-card-order-hint">
          Drag to reorder — #1 is what matters most to {audience.name}.
        </p>
      </div>

      {/* ── Confirm ────────────────────────────────── */}
      <div className="guided-card-actions">
        <button
          type="button"
          className="btn btn-primary guided-card-confirm"
          onClick={() => onConfirm(state)}
          disabled={
            state.offering.differentiators.filter(d => d.text.trim()).length === 0 ||
            audience.priorities.filter(p => p.text.trim()).length === 0 ||
            !allInferredVerified
          }
          title={!allInferredVerified ? `Quick yes/no on ${pendingInferredDiffs.length + pendingInferredPriorities.length} drafted item(s) above first` : undefined}
        >
          Build my message
        </button>
        {!allInferredVerified && (
          <p style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 8, textAlign: 'center' }}>
            {pendingInferredDiffs.length + pendingInferredPriorities.length} drafted {pendingInferredDiffs.length + pendingInferredPriorities.length === 1 ? 'item is' : 'items are'} still waiting on a quick yes/no above.
          </p>
        )}
      </div>
    </div>
  );
}
