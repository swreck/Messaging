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
      ref.current.select();
      // Auto-resize
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave(value.trim());
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
        onBlur={() => onSave(value.trim())}
        onKeyDown={handleKeyDown}
        rows={2}
      />
      <span className={`cell-word-count ${pct >= 1 ? 'over' : pct >= 0.8 ? 'warning' : 'ok'}`}>
        {words}/{maxWords}
      </span>
    </div>
  );
}
