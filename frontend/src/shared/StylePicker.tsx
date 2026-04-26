// Round C — Engineering Table style system: shared style picker component.
//
// Used in three places:
//   1. SettingsPage — pick the per-user default style.
//   2. Five Chapter Story creation form — per-deliverable override.
//   3. Deliverable metadata-row — change the active style on an existing deliverable.
//
// Values: '' (use default), 'TABLE_FOR_2', 'ENGINEERING_TABLE', 'PERSONALIZED'.
// The empty option ("Use my default") only appears in contexts that have a
// fall-through default — it's hidden in SettingsPage where the value IS the
// default.

import { useState, useEffect, useRef } from 'react';

export type StyleValue = '' | 'TABLE_FOR_2' | 'ENGINEERING_TABLE' | 'PERSONALIZED';

const OPTIONS: Array<{ value: Exclude<StyleValue, ''>; label: string; description: string }> = [
  {
    value: 'TABLE_FOR_2',
    label: 'Table for 2',
    description: "Maria's standard voice. Smart colleague stating facts plainly. Best for general business audiences.",
  },
  {
    value: 'ENGINEERING_TABLE',
    label: 'Engineering Table',
    description: 'Same plain-spoken voice, but assumes the reader is a sophisticated engineer. Architecture-first framing, named systems, technical specificity.',
  },
  {
    value: 'PERSONALIZED',
    label: 'Personalized',
    description: 'Uses your own learned voice. If you haven\'t built a voice profile yet, Maria falls back to Table for 2 until you train her.',
  },
];

interface Props {
  value: StyleValue;
  onChange: (next: StyleValue) => void;
  /** Show the "Use my default" pass-through option (e.g. on per-deliverable picker). */
  allowDefault?: boolean;
  /** Label rendered above the radio group. */
  label?: string;
  /** Optional hint shown under the label. */
  hint?: string;
  disabled?: boolean;
}

export function StylePicker({ value, onChange, allowDefault = false, label = 'Style', hint, disabled }: Props) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {hint && (
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 6px' }}>{hint}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {allowDefault && (
          <label className="style-picker-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: '1px solid var(--border-light, #e5e5ea)', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', background: value === '' ? 'rgba(0, 122, 255, 0.04)' : 'transparent' }}>
            <input
              type="radio"
              name={`style-picker-${label}`}
              checked={value === ''}
              onChange={() => onChange('')}
              disabled={disabled}
              style={{
                // The global `.form-group input` rule makes every input
                // 100% width, padded, bordered, and white-bg — which
                // turns this radio into a full-width text-input shell
                // and squeezes the label+description column off-screen.
                // Reset to native radio dimensions inside the picker.
                width: 'auto', padding: 0, border: 0, background: 'transparent', borderRadius: 0,
                flexShrink: 0, marginTop: 2,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>Use my default</div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>Use whatever I've set in Settings (or my organization's default).</div>
            </div>
          </label>
        )}
        {OPTIONS.map(opt => (
          <label
            key={opt.value}
            className="style-picker-row"
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              border: '1px solid var(--border-light, #e5e5ea)', borderRadius: 8,
              cursor: disabled ? 'not-allowed' : 'pointer',
              background: value === opt.value ? 'rgba(0, 122, 255, 0.04)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name={`style-picker-${label}`}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              disabled={disabled}
              style={{
                // The global `.form-group input` rule makes every input
                // 100% width, padded, bordered, and white-bg — which
                // turns this radio into a full-width text-input shell
                // and squeezes the label+description column off-screen.
                // Reset to native radio dimensions inside the picker.
                width: 'auto', padding: 0, border: 0, background: 'transparent', borderRadius: 0,
                flexShrink: 0, marginTop: 2,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{opt.label}</div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{opt.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

// Compact inline picker (used inside the deliverable metadata-row click pop-up).
// Anchors itself to the click target via a portal-less floating div.
interface InlineProps {
  value: StyleValue;
  onPick: (next: StyleValue) => void;
  onCancel: () => void;
  allowDefault?: boolean;
}
export function StylePickerInline({ value, onPick, onCancel, allowDefault = true }: InlineProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<StyleValue>(value);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onCancel]);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: '100%', left: 0, marginTop: 4,
        background: 'var(--bg-card, #fff)', border: '1px solid var(--border-light, #e5e5ea)',
        borderRadius: 10, padding: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        zIndex: 50, minWidth: 320, maxWidth: 380,
      }}
    >
      <StylePicker value={pending} onChange={setPending} allowDefault={allowDefault} label="Style for this deliverable" />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onPick(pending)}>Apply</button>
      </div>
    </div>
  );
}
