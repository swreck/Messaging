import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface InfoTooltipProps {
  text: string;
}

export function InfoTooltip({ text }: InfoTooltipProps) {
  const [show, setShow] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!show || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 8,
      left: Math.max(16, Math.min(rect.left + rect.width / 2 - 140, window.innerWidth - 296)),
    });
    const handler = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [show]);

  return (
    <span className="info-tooltip-wrapper">
      <span
        ref={btnRef}
        className="info-icon"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShow(!show); }}
        role="button"
        tabIndex={0}
        aria-label="More info"
      >
        i
      </span>
      {show && pos && createPortal(
        <div
          className="info-tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}
