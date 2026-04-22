import { useState, useRef, useEffect } from 'react';

interface CellEditorProps {
  text: string;
  maxWords: number;
  onSave: (text: string) => void;
  onCancel: () => void;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function CellEditor({ text, maxWords, onSave, onCancel }: CellEditorProps) {
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const words = countWords(value);
  const pct = words / maxWords;

  useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      // On touch devices, place cursor at end (select-all fights iOS text selection).
      // On desktop, select all so user can type to replace.
      const isTouch = window.matchMedia('(hover: none)').matches;
      if (isTouch) {
        const len = ref.current.value.length;
        ref.current.setSelectionRange(len, len);
      } else {
        ref.current.select();
      }
      // Auto-resize
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, []);

  const overLimit = words > maxWords;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!overLimit) onSave(value.trim());
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  }

  return (
    <div className="cell-editor">
      <textarea
        ref={ref}
        value={value}
        onChange={e => {
          setValue(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onBlur={() => { if (!overLimit) onSave(value.trim()); }}
        onKeyDown={handleKeyDown}
        rows={2}
      />
      <div className="cell-editor-footer">
        <span className={`cell-word-count ${overLimit ? 'over' : pct >= 0.8 ? 'warning' : 'ok'}`}>
          {overLimit ? `${words}/${maxWords} — trim to ${maxWords} to save` : `${words}/${maxWords}`}
        </span>
        <div className="cell-editor-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onMouseDown={e => e.preventDefault()}
            onClick={onCancel}
            aria-label="Cancel edit"
          >Cancel</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onMouseDown={e => e.preventDefault()}
            onClick={() => { if (!overLimit) onSave(value.trim()); }}
            disabled={overLimit}
            aria-label="Save edit"
          >Done</button>
        </div>
      </div>
    </div>
  );
}
