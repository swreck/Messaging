import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

const INTENTS: Record<string, { intent: string; quality: string }> = {
  tier1: {
    intent: 'The single most important value statement for this audience. Connects their #1 priority to your strongest differentiator.',
    quality: 'The listener thinks: "I thought I could ignore this issue, but I cannot. I don\'t necessarily need this solution, but I need to do something."',
  },
  tier2_focus: {
    intent: 'Shows your company\'s commitment to this audience. Not credentials — commitment to THEM.',
    quality: 'The reader feels: "This company is focused on people like me, not just selling to anyone."',
  },
  tier2_product: {
    intent: 'Your core product differentiation, matched to what the audience cares about.',
    quality: 'The reader thinks: "This addresses exactly what I\'m dealing with."',
  },
  tier2_roi: {
    intent: 'The financial or measurable value of using your product.',
    quality: 'The reader can calculate: "Here is what this is worth to me in concrete terms."',
  },
  tier2_support: {
    intent: 'Your commitment through processes: planning, configuration, training, ongoing support.',
    quality: 'The reader feels: "If I say yes, I won\'t be left figuring it out alone."',
  },
  tier2_proof: {
    intent: 'Other customers getting value, plus credible organizations giving recognition.',
    quality: 'The reader thinks: "People like me have already done this and it worked."',
  },
  tier3: {
    intent: 'Hard proof — specific, verifiable facts. Not value claims.',
    quality: 'A skeptic could verify this independently. Numbers, names, certifications, measurable outcomes.',
  },
  chapter1: {
    intent: 'Opens with a market truth the reader independently recognizes. Creates urgency to act.',
    quality: 'The reader thinks: "I thought I was OK not worrying about this, but I now realize I have to act."',
  },
  chapter2: {
    intent: 'Your approach — what the reader gets from your solution. Every sentence is about THEM.',
    quality: 'Every sentence focuses on what the reader GETS, not what the product DOES mechanically.',
  },
  chapter3: {
    intent: 'Trust — why working with you is safe. Addresses the risk of saying yes.',
    quality: 'The reader feels safe saying yes. Any risk they\'d worry about is addressed.',
  },
  chapter4: {
    intent: 'Proof — evidence from others who made this choice. Problem → solution → result format.',
    quality: 'Every fact is verifiable. Nothing feels invented or stretched.',
  },
  chapter5: {
    intent: 'Next step — something the reader can actually do this week.',
    quality: 'The ask is small enough to say yes to right now. Not a big commitment.',
  },
};

interface Props {
  elementType: string;
}

export function IntentIcon({ elementType }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const info = INTENTS[elementType];
  if (!info) return null;

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 320)),
    });
    const handler = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <span className="intent-icon-wrapper">
      <button
        ref={btnRef}
        type="button"
        className="intent-icon-btn"
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
        aria-label="What is this?"
      >
        i
      </button>
      {open && pos && createPortal(
        <>
          <div
            className="intent-icon-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="intent-icon-popover"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            onClick={e => e.stopPropagation()}
          >
            <div className="intent-icon-section">
              <span className="intent-icon-label">Intent</span>
              <p>{info.intent}</p>
            </div>
            <div className="intent-icon-section">
              <span className="intent-icon-label">Quality test</span>
              <p>{info.quality}</p>
            </div>
            <button type="button" className="intent-icon-close" onClick={() => setOpen(false)}>Got it</button>
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
