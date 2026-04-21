import { useState, useRef } from 'react';
import type { EnrichedInterpretation, FactSource } from './types';

interface Props {
  interpretation: EnrichedInterpretation;
  onConfirm: (edited: EnrichedInterpretation) => void;
}

export function InputConfirmationCard({ interpretation, onConfirm }: Props) {
  const [state, setState] = useState<EnrichedInterpretation>(interpretation);
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  // ── Differentiator editing ──────────────────────────
  function updateDiff(index: number, field: 'text' | 'motivatingFactor', value: string) {
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

  return (
    <div className="guided-input-card">
      {/* ── Summary ────────────────────────────────── */}
      <div className="guided-card-summary">
        Here's what I understood. Edit anything that's off — especially the "why" notes underneath each item. Getting the reason right is what makes the final message land.
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
            audience.priorities.filter(p => p.text.trim()).length === 0
          }
        >
          Build my message
        </button>
      </div>
    </div>
  );
}
