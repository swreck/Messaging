import { useState } from 'react';
import { IntentIcon } from './IntentIcon';

interface Chapter {
  chapterNum: number;
  title: string;
  content: string;
}

interface Props {
  blendedText: string;
  medium: string;
  chapters?: Chapter[];
  onCopy: () => void;
  onStartAnother: () => void;
}

const CHAPTER_PURPOSES: Record<number, string> = {
  1: 'The opening — makes the reader feel they need to act',
  2: 'Your approach — what the reader gets from your solution',
  3: 'Trust — why working with you is safe',
  4: 'Proof — evidence from others who made this choice',
  5: 'Next step — what the reader can do this week',
};

const CHAPTER_QUESTIONS: Record<number, string> = {
  1: 'Does this make the reader think "I need to do something about this"? Not that they need your product — just that they need to act.',
  2: 'Does every sentence focus on what the reader GETS? If any sentence describes what the product DOES mechanically, it should be rewritten.',
  3: 'Would the reader feel safe saying yes after reading this? If there\'s a risk they\'d worry about, is it addressed?',
  4: 'Is every fact here something you can verify? If anything feels invented or stretched, flag it.',
  5: 'Is this something the reader could actually do this week? If it feels like too big a commitment, it should be easier.',
};

export function DraftView({ blendedText, medium, chapters, onCopy, onStartAnother }: Props) {
  const [showSections, setShowSections] = useState(false);

  const paragraphs = blendedText
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  return (
    <div className="guided-draft-view" data-draft-text={blendedText}>
      {/* ── Blended draft ──────────────────────── */}
      <div className={`guided-draft-document guided-draft-${medium.replace(/\s+/g, '-')}`}>
        {paragraphs.length === 0 ? (
          <p className="guided-draft-empty">The draft came back empty. Try again with more detail.</p>
        ) : (
          paragraphs.map((para, i) => <p key={i}>{para}</p>)
        )}
      </div>

      {/* ── See sections toggle ────────────────── */}
      {chapters && chapters.length > 0 && (
        <div className="guided-draft-sections-toggle">
          <button
            type="button"
            className="guided-draft-sections-btn"
            onClick={() => setShowSections(!showSections)}
          >
            {showSections ? 'Hide sections' : 'See sections'}
          </button>

          {showSections && (
            <div className="guided-draft-sections">
              {chapters.map(ch => (
                <div key={ch.chapterNum} className="guided-draft-section">
                  <div className="guided-draft-section-header">
                    <span className="guided-draft-section-num">{ch.chapterNum}</span>
                    <span className="guided-draft-section-purpose">
                      {CHAPTER_PURPOSES[ch.chapterNum] || ch.title}
                    </span>
                    <IntentIcon elementType={`chapter${ch.chapterNum}`} />
                  </div>
                  {CHAPTER_QUESTIONS[ch.chapterNum] && (
                    <p className="guided-draft-section-question">{CHAPTER_QUESTIONS[ch.chapterNum]}</p>
                  )}
                  <div className="guided-draft-section-content">
                    {ch.content.split(/\n\n+/).map((p, i) => (
                      <p key={i}>{p.trim()}</p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Actions ────────────────────────────── */}
      <div className="guided-draft-actions">
        <button type="button" className="btn btn-primary" onClick={onCopy}>
          Copy draft
        </button>
        <button type="button" className="btn" onClick={onStartAnother}>
          New deliverable
        </button>
        <a href="/three-tiers" className="guided-draft-link">
          Edit in detail view
        </a>
      </div>
    </div>
  );
}
