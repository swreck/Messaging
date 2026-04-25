import { useEffect, useState } from 'react';

// Change 13 — Progress communication hierarchy, Middle level (Activity, no specifics).
// When a specific milestone is not honestly namable, but the work is happening,
// use this rotating phrase pool instead of three dots. The phrase pool should
// match what's actually happening — extraction phrases for extraction phase,
// mapping phrases for mapping phase, etc. Phrases rotate every ~3 seconds.
//
// CALLERS: pass a `phase` to pick the phrase pool, or pass a custom `phrases`
// array directly. Default rotation interval is 3 seconds.

type PhraseSet = {
  extraction: string[];
  mapping: string[];
  rebuild: string[];
  generic: string[];
};

const PHRASES: PhraseSet = {
  extraction: [
    'reading what you said',
    'looking for patterns',
    'pulling out the specials',
    'cross-checking against priorities',
    'shaping what I heard',
  ],
  mapping: [
    'weighing the connections',
    'checking for honesty',
    'matching what you offer to what they care about',
    'looking for the strong pairs',
    'flagging the thin ones',
  ],
  rebuild: [
    'rebuilding Tier 1 with that in',
    'reshaping the message',
    'reweighting the differentiators',
    'tightening the language',
  ],
  generic: [
    'composing',
    'rehabilitating',
    'polishing',
    'reconsidering',
    'thinking it through',
  ],
};

type Phase = keyof PhraseSet;

interface Props {
  phase?: Phase;
  phrases?: string[];
  intervalMs?: number;
}

export function RotatingPhrases({ phase = 'generic', phrases, intervalMs = 3000 }: Props) {
  const pool = phrases && phrases.length > 0 ? phrases : PHRASES[phase];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (pool.length <= 1) return;
    const t = setInterval(() => {
      setIndex(prev => (prev + 1) % pool.length);
    }, intervalMs);
    return () => clearInterval(t);
  }, [pool.length, intervalMs]);

  return (
    <span style={{ fontStyle: 'italic', opacity: 0.85 }}>
      {pool[index]}…
    </span>
  );
}
