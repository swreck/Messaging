// Express Flow — Interpretation Preview
//
// The surface where Maria shows the user what she understood from their
// free-form message, before committing to build anything. Every field is
// always editable — no separate "edit mode" — so the user can correct any
// piece of Maria's interpretation inline. The bar/wash visual language from
// 2.5's DifferentiatorList and PriorityList is reused: fields Maria inferred
// (guessed at) get a rose bar on the left; fields the user stated directly
// are clean.
//
// The user has two next-step options:
//   1. "Looks right — put together my first draft" — the primary path.
//   2. "Take me through it step by step instead" — hands off to the
//      existing Step 1-5 wizard with the interpretation pre-filled (the
//      "I want to get my hands dirty" escape hatch).
//
// No final-deliverable language anywhere. Maria produces first drafts.

import { useState } from 'react';
import type { ExpressInterpretation, FactSource, ExpressMedium } from './types';

const MEDIUM_OPTIONS: ExpressMedium[] = [
  'email',
  'pitch deck',
  'landing page',
  'blog post',
  'press release',
  'talking points',
  'newsletter',
  'one-pager',
  'report',
];

interface Props {
  initial: ExpressInterpretation;
  onConfirm: (edited: ExpressInterpretation) => void;
  onSwitchToWizard: (edited: ExpressInterpretation) => void;
}

export function InterpretationPreview({ initial, onConfirm, onSwitchToWizard }: Props) {
  const [state, setState] = useState<ExpressInterpretation>(initial);

  // ─── Edit helpers ──────────────────────────────────────────

  function updateOfferingName(name: string) {
    setState(s => ({
      ...s,
      offering: { ...s.offering, name, nameSource: 'stated' },
    }));
  }

  function updateOfferingDescription(description: string) {
    setState(s => ({ ...s, offering: { ...s.offering, description } }));
  }

  function updateDifferentiator(index: number, text: string) {
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: s.offering.differentiators.map((d, i) =>
          i === index ? { ...d, text, source: 'stated' as FactSource } : d,
        ),
      },
    }));
  }

  function removeDifferentiator(index: number) {
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: s.offering.differentiators.filter((_, i) => i !== index),
      },
    }));
  }

  function addDifferentiator() {
    setState(s => ({
      ...s,
      offering: {
        ...s.offering,
        differentiators: [...s.offering.differentiators, { text: '', source: 'stated' }],
      },
    }));
  }

  function updateAudienceName(aIdx: number, name: string) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, i) =>
        i === aIdx ? { ...a, name, source: 'stated' as FactSource } : a,
      ),
    }));
  }

  function updateAudienceDescription(aIdx: number, description: string) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, i) => (i === aIdx ? { ...a, description } : a)),
    }));
  }

  function updatePriority(aIdx: number, pIdx: number, text: string) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, i) =>
        i === aIdx
          ? {
              ...a,
              priorities: a.priorities.map((p, j) =>
                j === pIdx ? { ...p, text, source: 'stated' as FactSource } : p,
              ),
            }
          : a,
      ),
    }));
  }

  function removePriority(aIdx: number, pIdx: number) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, i) =>
        i === aIdx
          ? { ...a, priorities: a.priorities.filter((_, j) => j !== pIdx) }
          : a,
      ),
    }));
  }

  function addPriority(aIdx: number) {
    setState(s => ({
      ...s,
      audiences: s.audiences.map((a, i) =>
        i === aIdx
          ? { ...a, priorities: [...a.priorities, { text: '', source: 'stated' }] }
          : a,
      ),
    }));
  }

  function updateMedium(value: ExpressMedium) {
    setState(s => ({
      ...s,
      primaryMedium: { ...s.primaryMedium, value, source: 'stated' },
    }));
  }

  function updateSituation(situation: string) {
    setState(s => ({ ...s, situation }));
  }

  // ─── Render helpers ─────────────────────────────────────────

  function inferredClass(source: FactSource): string {
    return source === 'inferred' ? 'express-field express-field-inferred' : 'express-field';
  }

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="express-preview">
      <div className="express-preview-voice">
        <p>
          Here's what I understood. If I got anything wrong, just change it — everything is
          editable. When you're ready, tell me to go and I'll put together your first draft.
        </p>
      </div>

      {/* ─── What you need this to do ─────────────────────── */}
      <section className="express-section">
        <h2 className="express-section-title">What you need this to do</h2>
        <p className="express-section-hint">
          This is the most important thing I extracted. The first draft will be written for
          this specific situation — so if I got it wrong, fix it here before the rest.
        </p>
        <div className="express-field">
          <textarea
            className="express-textarea"
            value={state.situation || ''}
            onChange={e => updateSituation(e.target.value)}
            rows={4}
            placeholder="The specific thing you need this draft to do — the occasion, the audience reaction you're aiming for, any deadline or constraint."
          />
        </div>
      </section>

      {/* ─── Offering ─────────────────────────────────────── */}
      <section className="express-section">
        <h2 className="express-section-title">Your offering</h2>

        <div className={inferredClass(state.offering.nameSource)}>
          <label className="express-label">Name</label>
          <input
            className="express-input express-input-lg"
            value={state.offering.name}
            onChange={e => updateOfferingName(e.target.value)}
            placeholder="What do you call it?"
          />
        </div>

        <div className="express-field">
          <label className="express-label">What it does</label>
          <textarea
            className="express-textarea"
            value={state.offering.description}
            onChange={e => updateOfferingDescription(e.target.value)}
            rows={3}
            placeholder="One paragraph in your own words."
          />
        </div>

        <div className="express-field">
          <label className="express-label">
            What makes it different
            {state.offering.differentiators.some(d => d.source === 'inferred') && (
              <span className="express-hint"> — I've marked a few that I guessed at.</span>
            )}
          </label>
          <ul className="express-list">
            {state.offering.differentiators.map((d, i) => (
              <li key={i} className={inferredClass(d.source)}>
                <input
                  className="express-input"
                  value={d.text}
                  onChange={e => updateDifferentiator(i, e.target.value)}
                  placeholder="A capability or differentiator"
                />
                <button
                  type="button"
                  className="express-remove"
                  onClick={() => removeDifferentiator(i)}
                  aria-label="Remove"
                  title="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="express-add" onClick={addDifferentiator}>
            + Add another
          </button>
        </div>
      </section>

      {/* ─── Audiences ────────────────────────────────────── */}
      {state.audiences.map((aud, aIdx) => (
        <section key={aIdx} className="express-section">
          <h2 className="express-section-title">
            {state.audiences.length > 1 ? `Who you're talking to (${aIdx + 1} of ${state.audiences.length})` : "Who you're talking to"}
          </h2>

          {aud.source === 'inferred' && (
            <p className="express-section-hint">
              I guessed at this audience based on what you told me. If I picked the wrong person, change it here.
            </p>
          )}

          <div className={inferredClass(aud.source)}>
            <label className="express-label">Who they are</label>
            <input
              className="express-input express-input-lg"
              value={aud.name}
              onChange={e => updateAudienceName(aIdx, e.target.value)}
              placeholder="e.g., CFO at a regional bank"
            />
          </div>

          <div className="express-field">
            <label className="express-label">A little about them</label>
            <textarea
              className="express-textarea"
              value={aud.description}
              onChange={e => updateAudienceDescription(aIdx, e.target.value)}
              rows={2}
              placeholder="What they do, where they work, what their days look like."
            />
          </div>

          <div className="express-field">
            <label className="express-label">
              What they care about
              {aud.priorities.some(p => p.source === 'inferred') && (
                <span className="express-hint"> — these are my best read. Edit anything that doesn't ring true.</span>
              )}
            </label>
            <ul className="express-list">
              {aud.priorities.map((p, pIdx) => (
                <li key={pIdx} className={inferredClass(p.source)}>
                  <input
                    className="express-input"
                    value={p.text}
                    onChange={e => updatePriority(aIdx, pIdx, e.target.value)}
                    placeholder="Something they actually care about"
                  />
                  <button
                    type="button"
                    className="express-remove"
                    onClick={() => removePriority(aIdx, pIdx)}
                    aria-label="Remove"
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="express-add" onClick={() => addPriority(aIdx)}>
              + Add another
            </button>
          </div>
        </section>
      ))}

      {/* ─── Medium ───────────────────────────────────────── */}
      <section className="express-section">
        <h2 className="express-section-title">What format you need</h2>
        <div className={inferredClass(state.primaryMedium.source)}>
          <select
            className="express-select"
            value={state.primaryMedium.value}
            onChange={e => updateMedium(e.target.value as ExpressMedium)}
          >
            {MEDIUM_OPTIONS.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        {state.primaryMedium.reasoning && (
          <p className="express-section-hint">{state.primaryMedium.reasoning}</p>
        )}
      </section>

      {/* ─── Confidence note from Maria ───────────────────── */}
      {state.confidenceNotes && (
        <section className="express-note">
          <p className="express-note-label">A note from me</p>
          <p className="express-note-text">{state.confidenceNotes}</p>
        </section>
      )}

      {/* ─── Actions ──────────────────────────────────────── */}
      <div className="express-actions">
        <button
          type="button"
          className="btn btn-primary express-primary"
          onClick={() => onConfirm(state)}
        >
          Looks right — put together my first draft
        </button>
        <button
          type="button"
          className="express-wizard-link"
          onClick={() => onSwitchToWizard(state)}
        >
          Take me through it step by step instead
        </button>
      </div>
    </div>
  );
}
